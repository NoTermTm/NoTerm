mod local_pty;
mod ssh_manager;
mod telnet_manager;

use local_pty::LocalPtyManager;
use serde::{Deserialize, Serialize};
use ssh_manager::{
    ControlledCommandResult, ForwardConfig, KeepaliveConfig, SftpEntry, SshConnection,
    SshHostFingerprint, SshManager,
};
use std::collections::HashMap;
use std::fs;
use std::fs::OpenOptions;
use std::io::Write;
#[cfg(not(target_os = "macos"))]
use std::net::{TcpStream, ToSocketAddrs};
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Emitter;
use tauri::Manager;
use tauri::{AppHandle, State};
use telnet_manager::{TelnetConnection, TelnetManager};
use tokio::process::Command as TokioCommand;

struct AppState {
    ssh_manager: Mutex<SshManager>,
    telnet_manager: Mutex<TelnetManager>,
    local_pty_manager: Mutex<LocalPtyManager>,
}

#[derive(Debug, Clone, Serialize)]
struct EndpointCheck {
    ip: String,
    port: u16,
    latency_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct GeneratedKeypair {
    key_path: String,
    public_key: String,
    algorithm: String,
    comment: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
struct SystemHttpRequest {
    url: String,
    method: String,
    headers: Option<HashMap<String, String>>,
    body: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SystemHttpResponse {
    status: u16,
    status_text: String,
    body: String,
}

#[derive(Debug, Clone, Serialize)]
struct TerminalDebug {
    session_id: String,
    level: String,
    message: String,
}

fn emit_terminal_debug(app: &AppHandle, session_id: &str, level: &str, message: impl Into<String>) {
    let message = message.into();
    append_terminal_debug_log(session_id, level, &message);
    let _ = app.emit(
        "terminal-debug",
        TerminalDebug {
            session_id: session_id.to_string(),
            level: level.to_string(),
            message,
        },
    );
}

fn append_terminal_debug_log(session_id: &str, level: &str, message: &str) {
    let path = std::env::temp_dir().join("noterm-shell-debug.log");
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or(0);
    let sanitized = message.replace('\n', "\\n");
    if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
        let _ = writeln!(file, "[{}] [{}] [{}] {}", ts, session_id, level, sanitized);
    }
}

#[derive(Debug, Clone, Serialize)]
struct SftpTransferProgress {
    session_id: String,
    transfer_id: String,
    direction: String,
    transferred: u64,
    total: u64,
    percent: f64,
}

#[cfg(target_os = "linux")]
fn command_exists(cmd: &str) -> bool {
    let checker = if cfg!(target_os = "windows") {
        "where"
    } else {
        "which"
    };
    Command::new(checker)
        .arg(cmd)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
fn clipboard_read_text() -> Result<String, String> {
    #[cfg(target_os = "macos")]
    {
        let output = Command::new("pbpaste")
            .output()
            .map_err(|e| format!("Failed to read clipboard via pbpaste: {}", e))?;
        if output.status.success() {
            return String::from_utf8(output.stdout)
                .map_err(|e| format!("Clipboard is not valid UTF-8: {}", e));
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!("pbpaste failed: {}", stderr.trim()));
    }

    #[cfg(target_os = "windows")]
    {
        let output = Command::new("powershell")
            .args(["-NoProfile", "-Command", "Get-Clipboard -Raw"])
            .output()
            .map_err(|e| format!("Failed to read clipboard via PowerShell: {}", e))?;
        if output.status.success() {
            return Ok(String::from_utf8_lossy(&output.stdout).to_string());
        }
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "PowerShell clipboard read failed: {}",
            stderr.trim()
        ));
    }

    #[cfg(target_os = "linux")]
    {
        let candidates: [(&str, &[&str]); 3] = [
            ("wl-paste", &["--no-newline"]),
            ("xclip", &["-selection", "clipboard", "-o"]),
            ("xsel", &["--clipboard", "--output"]),
        ];

        for (cmd, args) in candidates {
            if !command_exists(cmd) {
                continue;
            }

            if let Ok(output) = Command::new(cmd).args(args).output() {
                if output.status.success() {
                    return Ok(String::from_utf8_lossy(&output.stdout).to_string());
                }
            }
        }

        return Err("No clipboard command available (tried wl-paste, xclip, xsel)".to_string());
    }

    #[allow(unreachable_code)]
    Err("Clipboard read is not supported on this platform".to_string())
}

#[tauri::command]
fn clipboard_write_text(text: String) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let mut child = Command::new("pbcopy")
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run pbcopy: {}", e))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("Failed to write to pbcopy: {}", e))?;
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        return if status.success() {
            Ok(())
        } else {
            Err("pbcopy failed".to_string())
        };
    }

    #[cfg(target_os = "windows")]
    {
        let mut child = Command::new("cmd")
            .args(["/c", "clip"])
            .stdin(Stdio::piped())
            .spawn()
            .map_err(|e| format!("Failed to run clip: {}", e))?;
        if let Some(mut stdin) = child.stdin.take() {
            stdin
                .write_all(text.as_bytes())
                .map_err(|e| format!("Failed to write to clip: {}", e))?;
        }
        let status = child.wait().map_err(|e| e.to_string())?;
        return if status.success() {
            Ok(())
        } else {
            Err("clip failed".to_string())
        };
    }

    #[cfg(target_os = "linux")]
    {
        let candidates: [(&str, &[&str]); 3] = [
            ("wl-copy", &[]),
            ("xclip", &["-selection", "clipboard"]),
            ("xsel", &["--clipboard", "--input"]),
        ];

        for (cmd, args) in candidates {
            if !command_exists(cmd) {
                continue;
            }

            if let Ok(mut child) = Command::new(cmd).args(args).stdin(Stdio::piped()).spawn() {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(text.as_bytes());
                }
                let status = child.wait().map_err(|e| e.to_string())?;
                if status.success() {
                    return Ok(());
                }
            }
        }

        return Err("No clipboard command available (tried wl-copy, xclip, xsel)".to_string());
    }

    #[allow(unreachable_code)]
    Err("Clipboard write is not supported on this platform".to_string())
}

#[tauri::command]
async fn ssh_check_endpoint(host: String, port: u16) -> Result<EndpointCheck, String> {
    tokio::task::spawn_blocking(move || -> Result<EndpointCheck, String> {
        let host = host.trim().to_string();
        if host.is_empty() {
            return Err("Host is empty".to_string());
        }

        #[cfg(target_os = "macos")]
        {
            // Keep timeout-based TCP probes out of the main app process on macOS.
            // In this runtime, a timed-out Rust connect_timeout can leave later
            // same-process connects failing with EBADF, which also breaks SSH
            // reconnects and unrelated plugin HTTP calls such as cloud sync.
            let start = Instant::now();
            let output = Command::new("/usr/bin/nc")
                .arg("-z")
                .arg("-G")
                .arg("2")
                .arg(&host)
                .arg(port.to_string())
                .output()
                .map_err(|e| format!("Failed to run endpoint check: {}", e))?;

            if output.status.success() {
                let latency_ms = start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                return Ok(EndpointCheck {
                    ip: host,
                    port,
                    latency_ms,
                });
            }

            let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
            let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
            let message = if !stderr.is_empty() { stderr } else { stdout };
            return Err(if message.is_empty() {
                "Endpoint check failed".to_string()
            } else {
                message
            });
        }

        #[cfg(not(target_os = "macos"))]
        {
            let addrs: Vec<_> = format!("{}:{}", host, port)
                .to_socket_addrs()
                .map_err(|e| e.to_string())?
                .collect();

            if addrs.is_empty() {
                return Err("No resolved addresses".to_string());
            }

            let timeout = Duration::from_millis(1500);
            let mut last_err: Option<String> = None;

            for addr in addrs {
                let start = Instant::now();
                match TcpStream::connect_timeout(&addr, timeout) {
                    Ok(stream) => {
                        let latency_ms =
                            start.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;
                        let peer = stream.peer_addr().map_err(|e| e.to_string())?;
                        return Ok(EndpointCheck {
                            ip: peer.ip().to_string(),
                            port: peer.port(),
                            latency_ms,
                        });
                    }
                    Err(e) => {
                        last_err = Some(e.to_string());
                    }
                }
            }

            Err(last_err.unwrap_or_else(|| "Connect failed".to_string()))
        }
    })
    .await
    .map_err(|e| e.to_string())?
}

fn sanitize_filename(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for ch in input.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else if ch.is_ascii_whitespace() {
            out.push('-');
        }
    }
    if out.is_empty() {
        "key".to_string()
    } else {
        out
    }
}

#[tauri::command]
async fn ssh_generate_keypair(
    app_handle: AppHandle,
    algorithm: String,
    name: String,
    passphrase: Option<String>,
    comment: Option<String>,
) -> Result<GeneratedKeypair, String> {
    tokio::task::spawn_blocking(move || -> Result<GeneratedKeypair, String> {
        let base = app_handle
            .path()
            .app_data_dir()
            .map_err(|e| e.to_string())?;

        let keys_dir = base.join("keys");
        fs::create_dir_all(&keys_dir).map_err(|e| e.to_string())?;

        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis();

        let safe = sanitize_filename(&name);
        let file_stem = format!("{}_{}", safe.chars().take(32).collect::<String>(), ts);
        let key_path = keys_dir.join(file_stem);

        let mut cmd = Command::new("ssh-keygen");
        cmd.arg("-q");

        match algorithm.as_str() {
            "ed25519" => {
                cmd.args(["-t", "ed25519"]);
            }
            "rsa4096" => {
                cmd.args(["-t", "rsa", "-b", "4096"]);
            }
            _ => {
                return Err("Unsupported algorithm".to_string());
            }
        }

        cmd.arg("-f").arg(&key_path);
        cmd.arg("-N").arg(passphrase.clone().unwrap_or_default());
        cmd.arg("-C")
            .arg(comment.clone().unwrap_or_else(|| name.clone()));

        let output = cmd
            .output()
            .map_err(|e| format!("Failed to run ssh-keygen (is it installed?): {}", e))?;

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let msg = stderr.trim();
            return Err(if msg.is_empty() {
                "ssh-keygen failed".to_string()
            } else {
                msg.to_string()
            });
        }

        let pub_path = std::path::PathBuf::from(format!("{}.pub", key_path.display()));
        let public_key = fs::read_to_string(&pub_path).map_err(|e| e.to_string())?;

        Ok(GeneratedKeypair {
            key_path: key_path.display().to_string(),
            public_key,
            algorithm,
            comment,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn ssh_connect(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    connection: SshConnection,
    keepalive: Option<KeepaliveConfig>,
    attempt_id: String,
) -> Result<String, String> {
    let exe_path = std::env::current_exe()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("unavailable: {}", error));
    let resource_dir = app_handle
        .path()
        .resource_dir()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|error| format!("unavailable: {}", error));
    emit_terminal_debug(
        &app_handle,
        &connection.id,
        "info",
        format!(
            "command ssh_connect invoked host={} port={} exe={} resource_dir={}",
            connection.host.trim(),
            connection.port,
            exe_path,
            resource_dir
        ),
    );
    let manager = state.ssh_manager.lock().unwrap().clone();
    let debug_app = app_handle.clone();
    let session_id = connection.id.clone();
    manager.start_connect_attempt(&session_id, &attempt_id);
    let attempt_id_for_worker = attempt_id.clone();
    let started_at = Instant::now();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        manager.connect(
            &connection,
            keepalive,
            app_handle,
            Some(&attempt_id_for_worker),
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());
    let elapsed_ms = started_at.elapsed().as_millis();
    match &result {
        Ok(_) => emit_terminal_debug(
            &debug_app,
            &session_id,
            "info",
            format!("command ssh_connect success elapsed_ms={}", elapsed_ms),
        ),
        Err(error) => emit_terminal_debug(
            &debug_app,
            &session_id,
            "error",
            format!("command ssh_connect failed elapsed_ms={}: {}", elapsed_ms, error),
        ),
    }
    result
}

#[tauri::command]
async fn ssh_get_host_fingerprint(
    state: State<'_, AppState>,
    connection: SshConnection,
) -> Result<SshHostFingerprint, String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<SshHostFingerprint> {
        manager.get_host_fingerprint(&connection)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn telnet_connect(
    state: State<'_, AppState>,
    connection: TelnetConnection,
) -> Result<String, String> {
    let manager = state.telnet_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<String> { manager.connect(&connection) })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_open_shell(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    session_id: String,
    attempt_id: String,
) -> Result<(), String> {
    emit_terminal_debug(
        &app_handle,
        &session_id,
        "info",
        "command ssh_open_shell invoked",
    );
    let manager = state.ssh_manager.lock().unwrap().clone();
    let debug_app = app_handle.clone();
    let debug_session_id = session_id.clone();
    let attempt_id_for_worker = attempt_id.clone();
    let started_at = Instant::now();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        manager.open_shell(&session_id, app_handle, Some(&attempt_id_for_worker))
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());
    let elapsed_ms = started_at.elapsed().as_millis();
    match &result {
        Ok(_) => emit_terminal_debug(
            &debug_app,
            &debug_session_id,
            "info",
            format!("command ssh_open_shell success elapsed_ms={}", elapsed_ms),
        ),
        Err(error) => emit_terminal_debug(
            &debug_app,
            &debug_session_id,
            "error",
            format!(
                "command ssh_open_shell failed elapsed_ms={}: {}",
                elapsed_ms, error
            ),
        ),
    }
    result
}

#[tauri::command]
async fn telnet_open_shell(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    session_id: String,
) -> Result<(), String> {
    let manager = state.telnet_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        manager.open_shell(&session_id, app_handle)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_write_to_shell(
    state: State<AppState>,
    app_handle: AppHandle,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let started_at = Instant::now();
    let manager = state.ssh_manager.lock().unwrap().clone();
    let result = manager
        .write_to_shell(&session_id, &data)
        .map_err(|e| e.to_string());
    let elapsed_ms = started_at.elapsed().as_millis();
    if elapsed_ms >= 100 {
        emit_terminal_debug(
            &app_handle,
            &session_id,
            "warn",
            format!(
                "command ssh_write_to_shell slow elapsed_ms={} bytes={}",
                elapsed_ms,
                data.len()
            ),
        );
    }
    if let Err(error) = &result {
        emit_terminal_debug(
            &app_handle,
            &session_id,
            "error",
            format!("command ssh_write_to_shell failed: {}", error),
        );
    }
    result
}

#[tauri::command]
fn telnet_write_to_shell(
    state: State<AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let manager = state.telnet_manager.lock().unwrap();
    manager
        .write_to_shell(&session_id, &data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_resize_pty(
    state: State<AppState>,
    app_handle: AppHandle,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    let result = manager
        .resize_pty(&session_id, cols, rows)
        .map_err(|e| e.to_string());
    if let Err(error) = &result {
        if error == "Shell not found" {
            return result;
        }
        emit_terminal_debug(
            &app_handle,
            &session_id,
            "warn",
            format!(
                "command ssh_resize_pty failed cols={} rows={} error={}",
                cols, rows, error
            ),
        );
    }
    result
}

#[tauri::command]
fn telnet_resize_pty(
    state: State<AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let manager = state.telnet_manager.lock().unwrap();
    manager
        .resize_pty(&session_id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn local_open_shell(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    session_id: String,
    shell: Option<String>,
) -> Result<(), String> {
    let manager = state.local_pty_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        manager.open_shell(&session_id, app_handle, shell)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn local_write_to_shell(
    state: State<AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let manager = state.local_pty_manager.lock().unwrap();
    manager
        .write_to_shell(&session_id, &data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn local_resize_pty(
    state: State<AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let manager = state.local_pty_manager.lock().unwrap();
    manager
        .resize_pty(&session_id, cols, rows)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn local_disconnect(state: State<AppState>, session_id: String) -> Result<(), String> {
    let manager = state.local_pty_manager.lock().unwrap();
    manager.disconnect(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
fn telnet_disconnect(state: State<AppState>, session_id: String) -> Result<(), String> {
    let manager = state.telnet_manager.lock().unwrap();
    manager.disconnect(&session_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_cancel_connect(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    session_id: String,
) -> Result<(), String> {
    emit_terminal_debug(
        &app_handle,
        &session_id,
        "info",
        "command ssh_cancel_connect invoked",
    );
    let manager = state.ssh_manager.lock().unwrap().clone();
    let debug_app = app_handle.clone();
    let debug_session_id = session_id.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        manager.cancel_connect(&session_id)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());
    if let Err(error) = &result {
        emit_terminal_debug(
            &debug_app,
            &debug_session_id,
            "warn",
            format!("command ssh_cancel_connect failed: {}", error),
        );
    }
    result
}

#[tauri::command]
async fn ssh_disconnect(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    session_id: String,
) -> Result<(), String> {
    emit_terminal_debug(
        &app_handle,
        &session_id,
        "info",
        "command ssh_disconnect invoked",
    );
    let manager = state.ssh_manager.lock().unwrap().clone();
    let debug_app = app_handle.clone();
    let debug_session_id = session_id.clone();
    let result = tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        manager.disconnect(&session_id)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string());
    if let Err(error) = &result {
        emit_terminal_debug(
            &debug_app,
            &debug_session_id,
            "warn",
            format!("command ssh_disconnect failed: {}", error),
        );
    }
    result
}

#[tauri::command]
async fn ssh_execute_command(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
) -> Result<String, String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<String> {
        manager.execute_command(&session_id, &command)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_execute_command_controlled(
    state: State<'_, AppState>,
    session_id: String,
    command: String,
    timeout_sec: u64,
) -> Result<ControlledCommandResult, String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<ControlledCommandResult> {
        manager.execute_command_controlled(&session_id, &command, timeout_sec)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn local_execute_command_controlled(
    session_id: String,
    command: String,
    timeout_sec: u64,
) -> Result<ControlledCommandResult, String> {
    let _ = session_id;
    let cmd_text = command.trim().to_string();
    if cmd_text.is_empty() {
        return Err("Command is empty".to_string());
    }

    let timeout_sec = timeout_sec.clamp(3, 300);
    let started_at = Instant::now();
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = TokioCommand::new("cmd");
        c.args(["/C", &cmd_text]);
        c
    } else {
        let mut c = TokioCommand::new("/bin/sh");
        c.args(["-lc", &cmd_text]);
        c
    };

    cmd.kill_on_drop(true);
    cmd.stdin(Stdio::null());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let timed = tokio::time::timeout(Duration::from_secs(timeout_sec), cmd.output()).await;
    match timed {
        Ok(Ok(output)) => Ok(ControlledCommandResult {
            exit_code: output.status.code().unwrap_or(-1),
            stdout: String::from_utf8_lossy(&output.stdout).to_string(),
            stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            duration_ms: started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            timed_out: false,
        }),
        Ok(Err(err)) => Err(err.to_string()),
        Err(_) => Ok(ControlledCommandResult {
            exit_code: -1,
            stdout: String::new(),
            stderr: "Command timed out".to_string(),
            duration_ms: started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            timed_out: true,
        }),
    }
}

#[tauri::command]
fn telnet_is_connected(state: State<AppState>, session_id: String) -> bool {
    let manager = state.telnet_manager.lock().unwrap();
    manager.is_connected(&session_id)
}

#[tauri::command]
fn ssh_is_connected(state: State<AppState>, app_handle: AppHandle, session_id: String) -> bool {
    let manager = state.ssh_manager.lock().unwrap().clone();
    let connected = manager.is_connected(&session_id);
    emit_terminal_debug(
        &app_handle,
        &session_id,
        "info",
        format!("command ssh_is_connected -> {}", connected),
    );
    connected
}

#[tauri::command]
fn telnet_list_sessions(state: State<AppState>) -> Vec<String> {
    let manager = state.telnet_manager.lock().unwrap();
    manager.list_sessions()
}

#[tauri::command]
fn ssh_list_sessions(state: State<AppState>) -> Vec<String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    manager.list_sessions()
}

#[tauri::command]
async fn ssh_forward_start(
    state: State<'_, AppState>,
    config: ForwardConfig,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> { manager.start_forward(config) })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_forward_stop(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> { manager.stop_forward(&id) })
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_forward_list(state: State<AppState>) -> Vec<String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    manager.list_forwards()
}

#[tauri::command]
async fn ssh_sftp_list_dir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<Vec<SftpEntry>> {
        manager.sftp_list_dir(&session_id, &path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_sftp_download_file(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    remote_path: String,
    local_path: String,
    transfer_id: Option<String>,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    let transfer_id = transfer_id.unwrap_or_else(|| format!("download:{}", remote_path));
    let cancel_token = manager.start_transfer(&transfer_id);
    let cleanup_cancel_token = cancel_token.clone();
    let cleanup_manager = manager.clone();
    let cleanup_transfer_id = transfer_id.clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        let result = manager.sftp_download_file(
            &session_id,
            &remote_path,
            &local_path,
            Some(cancel_token),
            |transferred, total| {
                let percent = if total > 0 {
                    (transferred as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
                } else {
                    0.0
                };
                let _ = app.emit(
                    "sftp-transfer-progress",
                    SftpTransferProgress {
                        session_id: session_id.clone(),
                        transfer_id: transfer_id.clone(),
                        direction: "download".to_string(),
                        transferred,
                        total,
                        percent,
                    },
                );
            },
        );
        cleanup_manager.finish_transfer(&cleanup_transfer_id, &cleanup_cancel_token);
        result
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_sftp_cancel_transfer(state: State<'_, AppState>, transfer_id: String) -> bool {
    let manager = state.ssh_manager.lock().unwrap();
    manager.cancel_transfer(&transfer_id)
}

#[tauri::command]
async fn ssh_sftp_upload_file(
    state: State<'_, AppState>,
    app: AppHandle,
    session_id: String,
    local_path: String,
    remote_path: String,
    transfer_id: Option<String>,
    use_temp_file: Option<bool>,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    let transfer_id = transfer_id.unwrap_or_else(|| format!("upload:{}", local_path));
    let use_temp_file = use_temp_file.unwrap_or(true);
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        manager.sftp_upload_file(
            &session_id,
            &local_path,
            &remote_path,
            use_temp_file,
            |transferred, total| {
                let percent = if total > 0 {
                    (transferred as f64 / total as f64 * 100.0).clamp(0.0, 100.0)
                } else {
                    0.0
                };
                let _ = app.emit(
                    "sftp-transfer-progress",
                    SftpTransferProgress {
                        session_id: session_id.clone(),
                        transfer_id: transfer_id.clone(),
                        direction: "upload".to_string(),
                        transferred,
                        total,
                        percent,
                    },
                );
            },
        )
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_sftp_rename(
    state: State<'_, AppState>,
    session_id: String,
    from_path: String,
    to_path: String,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        manager.sftp_rename(&session_id, &from_path, &to_path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_sftp_chmod(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    mode: u32,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        manager.sftp_chmod(&session_id, &path, mode)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_sftp_delete(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
    is_dir: bool,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        manager.sftp_delete(&session_id, &path, is_dir)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_sftp_mkdir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || -> anyhow::Result<()> {
        manager.sftp_mkdir(&session_id, &path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn system_http_request(request: SystemHttpRequest) -> Result<SystemHttpResponse, String> {
    tokio::task::spawn_blocking(move || -> Result<SystemHttpResponse, String> {
        let url = request.url.trim();
        if !(url.starts_with("https://") || url.starts_with("http://")) {
            return Err("Only http(s) URLs are supported".to_string());
        }

        let method = request.method.trim().to_uppercase();
        if method.is_empty() {
            return Err("HTTP method is empty".to_string());
        }

        let status_marker = "\n__NOTERM_HTTP_STATUS__:";
        let mut cmd = Command::new("/usr/bin/curl");
        cmd.arg("--silent")
            .arg("--show-error")
            .arg("--max-time")
            .arg("60")
            .arg("--request")
            .arg(&method);

        if let Some(headers) = request.headers {
            for (name, value) in headers {
                if name.contains('\n') || value.contains('\n') {
                    return Err("HTTP headers must not contain newlines".to_string());
                }
                cmd.arg("--header").arg(format!("{}: {}", name, value));
            }
        }

        let has_body = request.body.is_some();
        if has_body {
            cmd.arg("--data-binary").arg("@-");
            cmd.stdin(Stdio::piped());
        } else {
            cmd.stdin(Stdio::null());
        }

        cmd.arg("--write-out")
            .arg(format!("{}%{{http_code}}", status_marker))
            .arg(url)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("Failed to run curl: {}", e))?;

        if let Some(body) = request.body {
            if let Some(mut stdin) = child.stdin.take() {
                stdin
                    .write_all(body.as_bytes())
                    .map_err(|e| format!("Failed to write curl request body: {}", e))?;
            }
        }

        let output = child
            .wait_with_output()
            .map_err(|e| format!("Failed to wait for curl: {}", e))?;

        let stdout = String::from_utf8_lossy(&output.stdout).to_string();
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let Some((body, status_raw)) = stdout.rsplit_once(status_marker) else {
            return Err(if stderr.is_empty() {
                "curl did not return an HTTP status".to_string()
            } else {
                stderr
            });
        };

        let status = status_raw
            .trim()
            .parse::<u16>()
            .map_err(|_| format!("Invalid curl HTTP status: {}", status_raw.trim()))?;

        if !output.status.success() && status == 0 {
            return Err(if stderr.is_empty() {
                "curl request failed".to_string()
            } else {
                stderr
            });
        }

        Ok(SystemHttpResponse {
            status,
            status_text: String::new(),
            body: body.to_string(),
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_http::init())
        .setup(|app| {
            #[cfg(desktop)]
            {
                let app_handle = app.handle();
                app_handle.plugin(tauri_plugin_updater::Builder::new().build())?;

                #[cfg(debug_assertions)]
                if let Some(main_window) = app_handle.get_webview_window("main") {
                    main_window.open_devtools();
                }
            }
            Ok(())
        })
        .manage(AppState {
            ssh_manager: Mutex::new(SshManager::new()),
            telnet_manager: Mutex::new(TelnetManager::new()),
            local_pty_manager: Mutex::new(LocalPtyManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            clipboard_read_text,
            clipboard_write_text,
            ssh_check_endpoint,
            ssh_generate_keypair,
            ssh_connect,
            ssh_get_host_fingerprint,
            telnet_connect,
            ssh_open_shell,
            telnet_open_shell,
            ssh_write_to_shell,
            telnet_write_to_shell,
            local_write_to_shell,
            ssh_resize_pty,
            telnet_resize_pty,
            ssh_cancel_connect,
            ssh_disconnect,
            telnet_disconnect,
            local_open_shell,
            local_resize_pty,
            local_disconnect,
            ssh_execute_command,
            ssh_execute_command_controlled,
            local_execute_command_controlled,
            ssh_is_connected,
            telnet_is_connected,
            ssh_list_sessions,
            telnet_list_sessions,
            ssh_forward_start,
            ssh_forward_stop,
            ssh_forward_list,
            ssh_sftp_list_dir,
            ssh_sftp_download_file,
            ssh_sftp_cancel_transfer,
            ssh_sftp_upload_file,
            ssh_sftp_rename,
            ssh_sftp_chmod,
            ssh_sftp_delete,
            ssh_sftp_mkdir,
            system_http_request
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

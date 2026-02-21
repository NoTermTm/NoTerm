mod local_pty;
mod ssh_manager;

use serde::{Deserialize, Serialize};
use local_pty::LocalPtyManager;
use ssh_manager::{ForwardConfig, SftpEntry, SshConnection, SshManager};
use std::fs;
use std::sync::Mutex;
use std::net::{TcpStream, ToSocketAddrs};
use std::io::Write;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tauri::Manager;

struct AppState {
    ssh_manager: Mutex<SshManager>,
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
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
struct RdpConnection {
    id: String,
    name: String,
    host: String,
    port: u16,
    username: String,
    password: Option<String>,
    gateway_host: Option<String>,
    gateway_username: Option<String>,
    gateway_password: Option<String>,
    gateway_domain: Option<String>,
    resolution_width: Option<u32>,
    resolution_height: Option<u32>,
    color_depth: Option<u32>,
    cert_policy: Option<String>,
    redirect_clipboard: Option<bool>,
    redirect_audio: Option<bool>,
    redirect_drives: Option<bool>,
}

fn command_exists(cmd: &str) -> bool {
    let checker = if cfg!(target_os = "windows") { "where" } else { "which" };
    Command::new(checker)
        .arg(cmd)
        .output()
        .map(|out| out.status.success())
        .unwrap_or(false)
}

fn build_rdp_content(conn: &RdpConnection) -> String {
    let mut lines: Vec<String> = Vec::new();
    lines.push(format!("full address:s:{}:{}", conn.host, conn.port));
    if !conn.username.is_empty() {
        lines.push(format!("username:s:{}", conn.username));
    }

    let prompt = conn.password.as_deref().unwrap_or("").is_empty();
    lines.push(format!("prompt for credentials:i:{}", if prompt { 1 } else { 0 }));
    lines.push("promptcredentialonce:i:1".to_string());

    if let (Some(w), Some(h)) = (conn.resolution_width, conn.resolution_height) {
        lines.push(format!("desktopwidth:i:{}", w));
        lines.push(format!("desktopheight:i:{}", h));
        lines.push("screen mode id:i:1".to_string());
    } else {
        lines.push("screen mode id:i:2".to_string());
    }

    if let Some(depth) = conn.color_depth {
        lines.push(format!("session bpp:i:{}", depth));
    }

    if conn.cert_policy.as_deref() == Some("ignore") {
        lines.push("authentication level:i:0".to_string());
    } else {
        lines.push("authentication level:i:2".to_string());
    }

    let redirect_clipboard = conn.redirect_clipboard.unwrap_or(true);
    lines.push(format!("redirectclipboard:i:{}", if redirect_clipboard { 1 } else { 0 }));

    let redirect_audio = conn.redirect_audio.unwrap_or(false);
    lines.push(format!("audiomode:i:{}", if redirect_audio { 0 } else { 2 }));

    let redirect_drives = conn.redirect_drives.unwrap_or(false);
    lines.push(format!("drivestoredirect:s:{}", if redirect_drives { "*" } else { "" }));

    if let Some(gateway) = conn.gateway_host.as_deref() {
        if !gateway.is_empty() {
            lines.push(format!("gatewayhostname:s:{}", gateway));
            lines.push("gatewayusagemethod:i:1".to_string());
            let gw_user = conn.gateway_username.as_deref().unwrap_or("").to_string();
            let gw_domain = conn.gateway_domain.as_deref().unwrap_or("").to_string();
            if !gw_user.is_empty() {
                let full_user = if gw_domain.is_empty() {
                    gw_user
                } else {
                    format!("{}\\{}", gw_domain, gw_user)
                };
                lines.push(format!("gatewayusername:s:{}", full_user));
                lines.push("gatewaycredentialssource:i:4".to_string());
            }
        }
    }

    lines.join("\n")
}

#[tauri::command]
async fn rdp_open(app_handle: AppHandle, connection: RdpConnection) -> Result<(), String> {
    let base = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let rdp_dir = base.join("rdp");
    fs::create_dir_all(&rdp_dir).map_err(|e| e.to_string())?;
    let rdp_path = rdp_dir.join(format!("{}.rdp", connection.id));
    let content = build_rdp_content(&connection);
    fs::write(&rdp_path, content).map_err(|e| e.to_string())?;

    if command_exists("xfreerdp") {
        let mut cmd = Command::new("xfreerdp");
        cmd.arg(format!("/v:{}:{}", connection.host, connection.port));
        if !connection.username.is_empty() {
            cmd.arg(format!("/u:{}", connection.username));
        }
        if let Some(pass) = connection.password.as_deref() {
            if !pass.is_empty() {
                cmd.arg(format!("/p:{}", pass));
            }
        }
        if connection.cert_policy.as_deref() == Some("ignore") {
            cmd.arg("/cert:ignore");
        }
        if let (Some(w), Some(h)) = (connection.resolution_width, connection.resolution_height) {
            cmd.arg(format!("/size:{}x{}", w, h));
        }
        if let Some(depth) = connection.color_depth {
            cmd.arg(format!("/bpp:{}", depth));
        }
        if connection.redirect_clipboard.unwrap_or(true) {
            cmd.arg("+clipboard");
        } else {
            cmd.arg("-clipboard");
        }
        if let Some(gateway) = connection.gateway_host.as_deref() {
            if !gateway.is_empty() {
                cmd.arg(format!("/g:{}", gateway));
            }
        }
        if let Some(user) = connection.gateway_username.as_deref() {
            if !user.is_empty() {
                cmd.arg(format!("/gu:{}", user));
            }
        }
        if let Some(pass) = connection.gateway_password.as_deref() {
            if !pass.is_empty() {
                cmd.arg(format!("/gp:{}", pass));
            }
        }
        if let Some(domain) = connection.gateway_domain.as_deref() {
            if !domain.is_empty() {
                cmd.arg(format!("/gd:{}", domain));
            }
        }
        cmd.spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }

    if cfg!(target_os = "windows") {
        if let Some(pass) = connection.password.as_deref() {
            if !pass.is_empty() {
                let target = format!("TERMSRV/{}", connection.host);
                let _ = Command::new("cmdkey")
                    .args([
                        format!("/generic:{}", target),
                        format!("/user:{}", connection.username),
                        format!("/pass:{}", pass),
                    ])
                    .status();
            }
        }
        Command::new("mstsc")
            .arg(&rdp_path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    if cfg!(target_os = "macos") {
        Command::new("open")
            .arg(&rdp_path)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }

    Command::new("xdg-open")
        .arg(&rdp_path)
        .spawn()
        .map_err(|e| e.to_string())?;

    Ok(())
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
            return Ok(String::from_utf8_lossy(&output.stdout).to_string());
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
        return Err(format!("PowerShell clipboard read failed: {}", stderr.trim()));
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
    tokio::task::spawn_blocking(move || {
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
    tokio::task::spawn_blocking(move || {
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
        cmd.arg("-C").arg(comment.clone().unwrap_or_else(|| name.clone()));

        let output = cmd.output().map_err(|e| {
            format!(
                "Failed to run ssh-keygen (is it installed?): {}",
                e
            )
        })?;

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
    connection: SshConnection,
) -> Result<String, String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || {
        manager.connect(&connection)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_open_shell(
    state: State<'_, AppState>,
    app_handle: AppHandle,
    session_id: String,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || {
        manager.open_shell(&session_id, app_handle)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_write_to_shell(
    state: State<AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap();
    manager
        .write_to_shell(&session_id, &data)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_resize_pty(
    state: State<AppState>,
    session_id: String,
    cols: u32,
    rows: u32,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap();
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
    tokio::task::spawn_blocking(move || manager.open_shell(&session_id, app_handle, shell))
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
    manager
        .disconnect(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_disconnect(state: State<AppState>, session_id: String) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap();
    manager
        .disconnect(&session_id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_execute_command(
    state: State<AppState>,
    session_id: String,
    command: String,
) -> Result<String, String> {
    let manager = state.ssh_manager.lock().unwrap();
    manager
        .execute_command(&session_id, &command)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_is_connected(state: State<AppState>, session_id: String) -> bool {
    let manager = state.ssh_manager.lock().unwrap();
    manager.is_connected(&session_id)
}

#[tauri::command]
fn ssh_list_sessions(state: State<AppState>) -> Vec<String> {
    let manager = state.ssh_manager.lock().unwrap();
    manager.list_sessions()
}

#[tauri::command]
async fn ssh_forward_start(
    state: State<'_, AppState>,
    config: ForwardConfig,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || manager.start_forward(config))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_forward_stop(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || manager.stop_forward(&id))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn ssh_forward_list(state: State<AppState>) -> Vec<String> {
    let manager = state.ssh_manager.lock().unwrap();
    manager.list_forwards()
}

#[tauri::command]
async fn ssh_sftp_list_dir(
    state: State<'_, AppState>,
    session_id: String,
    path: String,
) -> Result<Vec<SftpEntry>, String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || manager.sftp_list_dir(&session_id, &path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_sftp_download_file(
    state: State<'_, AppState>,
    session_id: String,
    remote_path: String,
    local_path: String,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || {
        manager.sftp_download_file(&session_id, &remote_path, &local_path)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

#[tauri::command]
async fn ssh_sftp_upload_file(
    state: State<'_, AppState>,
    session_id: String,
    local_path: String,
    remote_path: String,
) -> Result<(), String> {
    let manager = state.ssh_manager.lock().unwrap().clone();
    tokio::task::spawn_blocking(move || {
        manager.sftp_upload_file(&session_id, &local_path, &remote_path)
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
    tokio::task::spawn_blocking(move || {
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
    tokio::task::spawn_blocking(move || manager.sftp_chmod(&session_id, &path, mode))
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
    tokio::task::spawn_blocking(move || manager.sftp_delete(&session_id, &path, is_dir))
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
    tokio::task::spawn_blocking(move || manager.sftp_mkdir(&session_id, &path))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .setup(|app| {
            #[cfg(desktop)]
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            Ok(())
        })
        .manage(AppState {
            ssh_manager: Mutex::new(SshManager::new()),
            local_pty_manager: Mutex::new(LocalPtyManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            clipboard_read_text,
            clipboard_write_text,
            ssh_check_endpoint,
            ssh_generate_keypair,
            rdp_open,
            ssh_connect,
            ssh_open_shell,
            ssh_write_to_shell,
            ssh_resize_pty,
            ssh_disconnect,
            local_open_shell,
            local_write_to_shell,
            local_resize_pty,
            local_disconnect,
            ssh_execute_command,
            ssh_is_connected,
            ssh_list_sessions,
            ssh_forward_start,
            ssh_forward_stop,
            ssh_forward_list,
            ssh_sftp_list_dir,
            ssh_sftp_download_file,
            ssh_sftp_upload_file,
            ssh_sftp_rename,
            ssh_sftp_chmod,
            ssh_sftp_delete,
            ssh_sftp_mkdir
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

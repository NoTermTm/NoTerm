mod ssh_manager;

use serde::Serialize;
use ssh_manager::{SftpEntry, SshConnection, SshManager};
use std::fs;
use std::sync::Mutex;
use std::net::{TcpStream, ToSocketAddrs};
use std::process::Command;
use std::time::{Duration, Instant};
use tauri::{AppHandle, State};
use tauri::Manager;

struct AppState {
    ssh_manager: Mutex<SshManager>,
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

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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
        .manage(AppState {
            ssh_manager: Mutex::new(SshManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            ssh_check_endpoint,
            ssh_generate_keypair,
            ssh_connect,
            ssh_open_shell,
            ssh_write_to_shell,
            ssh_resize_pty,
            ssh_disconnect,
            ssh_execute_command,
            ssh_is_connected,
            ssh_list_sessions,
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

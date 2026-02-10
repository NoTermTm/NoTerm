mod ssh_manager;

use ssh_manager::{SshConnection, SshManager};
use std::sync::Mutex;
use tauri::{AppHandle, State};

struct AppState {
    ssh_manager: Mutex<SshManager>,
}

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .manage(AppState {
            ssh_manager: Mutex::new(SshManager::new()),
        })
        .invoke_handler(tauri::generate_handler![
            greet,
            ssh_connect,
            ssh_open_shell,
            ssh_write_to_shell,
            ssh_resize_pty,
            ssh_disconnect,
            ssh_execute_command,
            ssh_is_connected,
            ssh_list_sessions
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

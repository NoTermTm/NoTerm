use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::Serialize;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};
use tauri::Emitter;
use std::path::Path;

#[derive(Clone, Serialize)]
struct TerminalOutput {
    session_id: String,
    data: String,
}

struct LocalPtySession {
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send>>,
}

#[derive(Clone)]
pub struct LocalPtyManager {
    sessions: Arc<Mutex<HashMap<String, LocalPtySession>>>,
}

impl LocalPtyManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn open_shell(
        &self,
        session_id: &str,
        app_handle: tauri::AppHandle,
        shell: Option<String>,
    ) -> anyhow::Result<()> {
        let _ = self.disconnect(session_id);

        let shell_path = resolve_shell_path(shell);

        let pty_system = native_pty_system();
        let pair = pty_system.openpty(PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        let mut cmd = CommandBuilder::new(shell_path);
        cmd.env("TERM", "xterm-256color");
        if let Some(home) = resolve_home_dir() {
            cmd.cwd(home);
        }

        let child = pair.slave.spawn_command(cmd)?;
        drop(pair.slave);

        let mut reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;
        let master = pair.master;

        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(
            session_id.to_string(),
            LocalPtySession {
                master: Mutex::new(master),
                writer: Mutex::new(writer),
                child: Mutex::new(child),
            },
        );
        drop(sessions);

        let session_id = session_id.to_string();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => break,
                    Ok(n) => {
                        let output = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let _ = app_handle.emit(
                            "terminal-output",
                            TerminalOutput {
                                session_id: session_id.clone(),
                                data: output,
                            },
                        );
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {
                        continue;
                    }
                    Err(_) => break,
                }
            }
        });

        Ok(())
    }

    pub fn write_to_shell(&self, session_id: &str, data: &str) -> anyhow::Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Local session not found"))?;

        let mut writer = session.writer.lock().unwrap();
        writer.write_all(data.as_bytes())?;
        writer.flush()?;

        Ok(())
    }

    pub fn resize_pty(&self, session_id: &str, cols: u32, rows: u32) -> anyhow::Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Local session not found"))?;

        let master = session.master.lock().unwrap();
        let safe_cols = std::cmp::min(cols, u16::MAX as u32) as u16;
        let safe_rows = std::cmp::min(rows, u16::MAX as u32) as u16;
        master.resize(PtySize {
            rows: safe_rows,
            cols: safe_cols,
            pixel_width: 0,
            pixel_height: 0,
        })?;

        Ok(())
    }

    pub fn disconnect(&self, session_id: &str) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(session_id) {
            if let Ok(mut child) = session.child.lock() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }

        Ok(())
    }
}

fn resolve_shell_path(shell: Option<String>) -> String {
    let from_input = shell
        .and_then(|value| {
            let trimmed = value.trim().to_string();
            if trimmed.is_empty() {
                None
            } else {
                Some(trimmed)
            }
        });

    if let Some(shell_path) = from_input {
        return shell_path;
    }

    if cfg!(target_os = "windows") {
        if let Ok(shell_env) = std::env::var("SHELL") {
            if !shell_env.trim().is_empty() && Path::new(&shell_env).exists() {
                return shell_env;
            }
        }
        if let Ok(comspec) = std::env::var("COMSPEC") {
            if !comspec.trim().is_empty() {
                return comspec;
            }
        }
        if let Ok(system_root) = std::env::var("SystemRoot") {
            let powershell = Path::new(&system_root)
                .join("System32")
                .join("WindowsPowerShell")
                .join("v1.0")
                .join("powershell.exe");
            if powershell.exists() {
                return powershell.to_string_lossy().to_string();
            }
        }
        return "cmd.exe".to_string();
    }

    std::env::var("SHELL")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| "/bin/bash".to_string())
}

fn resolve_home_dir() -> Option<String> {
    if cfg!(target_os = "windows") {
        std::env::var("USERPROFILE")
            .ok()
            .filter(|value| !value.trim().is_empty())
    } else {
        std::env::var("HOME")
            .ok()
            .filter(|value| !value.trim().is_empty())
    }
}

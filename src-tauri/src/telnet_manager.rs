use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};
use std::time::Duration;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TelnetConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub password: Option<String>,
    pub encoding: Option<String>,
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone, Serialize)]
struct TerminalDisconnected {
    session_id: String,
    reason: String,
}

#[derive(Clone)]
struct TelnetSession {
    writer: Arc<Mutex<TcpStream>>,
    connected: Arc<AtomicBool>,
    connection: TelnetConnection,
}

#[derive(Clone)]
pub struct TelnetManager {
    sessions: Arc<Mutex<HashMap<String, TelnetSession>>>,
}

impl TelnetManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn connect(&self, connection: &TelnetConnection) -> anyhow::Result<String> {
        let host = connection.host.trim();
        if host.is_empty() {
            return Err(anyhow::anyhow!("Host is empty"));
        }

        let addrs: Vec<_> = format!("{}:{}", host, connection.port)
            .to_socket_addrs()?
            .collect();
        if addrs.is_empty() {
            return Err(anyhow::anyhow!("Failed to resolve host: {}", host));
        }

        let mut last_error: Option<String> = None;
        for addr in addrs {
            match TcpStream::connect_timeout(&addr, Duration::from_secs(10)) {
                Ok(stream) => {
                    stream.set_read_timeout(Some(Duration::from_millis(400)))?;
                    stream.set_write_timeout(Some(Duration::from_secs(15)))?;
                    let _ = stream.set_nodelay(true);

                    let session_id = if connection.id.trim().is_empty() {
                        format!(
                            "telnet-{}",
                            SystemTime::now()
                                .duration_since(UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis()
                        )
                    } else {
                        connection.id.clone()
                    };

                    let _ = self.disconnect(&session_id);

                    let session = TelnetSession {
                        writer: Arc::new(Mutex::new(stream)),
                        connected: Arc::new(AtomicBool::new(true)),
                        connection: connection.clone(),
                    };
                    self.sessions
                        .lock()
                        .unwrap()
                        .insert(session_id.clone(), session);
                    return Ok(session_id);
                }
                Err(err) => {
                    last_error = Some(err.to_string());
                }
            }
        }

        Err(anyhow::anyhow!(
            "{}",
            last_error.unwrap_or_else(|| "Connect failed".to_string())
        ))
    }

    pub fn open_shell(&self, session_id: &str, app_handle: tauri::AppHandle) -> anyhow::Result<()> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .get(session_id)
            .cloned()
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

        let session_id = session_id.to_string();
        let writer = session.writer.clone();
        let connected = session.connected.clone();
        let connection = session.connection.clone();
        let sessions_map = self.sessions.clone();
        std::thread::spawn(move || {
            let mut reader = match writer.lock().unwrap().try_clone() {
                Ok(stream) => stream,
                Err(err) => {
                    let _ = app_handle.emit(
                        "terminal-disconnected",
                        TerminalDisconnected {
                            session_id: session_id.clone(),
                            reason: err.to_string(),
                        },
                    );
                    return;
                }
            };

            let mut buffer = [0u8; 8192];
            let mut recent_output = String::new();
            let mut sent_username = false;
            let mut sent_password = false;
            let username = connection.username.trim().to_string();
            let password = connection.password.unwrap_or_default();
            let mut disconnected_reason: Option<String> = None;

            loop {
                if !connected.load(Ordering::SeqCst) {
                    break;
                }

                match reader.read(&mut buffer) {
                    Ok(0) => {
                        disconnected_reason = Some("eof".to_string());
                        break;
                    }
                    Ok(n) => {
                        let output = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let _ = app_handle.emit(
                            "terminal-output",
                            TerminalOutput {
                                session_id: session_id.clone(),
                                data: output.clone(),
                            },
                        );

                        recent_output.push_str(&output.to_lowercase());
                        if recent_output.len() > 512 {
                            let keep_from = recent_output.len().saturating_sub(512);
                            recent_output = recent_output[keep_from..].to_string();
                        }

                        if !sent_username
                            && !username.is_empty()
                            && (recent_output.contains("login:") || recent_output.contains("username:"))
                        {
                            if let Ok(mut lock) = writer.lock() {
                                let _ = lock.write_all(format!("{}\n", username).as_bytes());
                                let _ = lock.flush();
                            }
                            sent_username = true;
                            recent_output.clear();
                        }

                        if !sent_password
                            && !password.is_empty()
                            && recent_output.contains("password:")
                        {
                            if let Ok(mut lock) = writer.lock() {
                                let _ = lock.write_all(format!("{}\n", password).as_bytes());
                                let _ = lock.flush();
                            }
                            sent_password = true;
                            recent_output.clear();
                        }
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => continue,
                    Err(err) if err.kind() == std::io::ErrorKind::TimedOut => continue,
                    Err(err) => {
                        disconnected_reason = Some(err.to_string());
                        break;
                    }
                }
            }

            connected.store(false, Ordering::SeqCst);
            if let Ok(mut sessions) = sessions_map.lock() {
                sessions.remove(&session_id);
            }
            if let Some(reason) = disconnected_reason {
                let _ = app_handle.emit(
                    "terminal-disconnected",
                    TerminalDisconnected {
                        session_id: session_id.clone(),
                        reason,
                    },
                );
            }
        });

        Ok(())
    }

    pub fn write_to_shell(&self, session_id: &str, data: &str) -> anyhow::Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?;
        if !session.connected.load(Ordering::SeqCst) {
            return Err(anyhow::anyhow!("Session is disconnected"));
        }

        let mut writer = session.writer.lock().unwrap();
        writer.write_all(data.as_bytes())?;
        writer.flush()?;
        Ok(())
    }

    pub fn resize_pty(&self, _session_id: &str, _cols: u32, _rows: u32) -> anyhow::Result<()> {
        Ok(())
    }

    pub fn disconnect(&self, session_id: &str) -> anyhow::Result<()> {
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(session_id) {
            session.connected.store(false, Ordering::SeqCst);
            if let Ok(stream) = session.writer.lock() {
                let _ = stream.shutdown(Shutdown::Both);
            }
        }
        Ok(())
    }

    pub fn is_connected(&self, session_id: &str) -> bool {
        self.sessions
            .lock()
            .unwrap()
            .get(session_id)
            .is_some_and(|session| session.connected.load(Ordering::SeqCst))
    }

    pub fn list_sessions(&self) -> Vec<String> {
        self.sessions.lock().unwrap().keys().cloned().collect()
    }
}

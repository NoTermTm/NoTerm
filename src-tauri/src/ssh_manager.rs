use serde::{Deserialize, Serialize};
use ssh2::Session;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::sync::{Arc, Mutex};
use std::path::Path;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthType {
    Password { password: String },
    PrivateKey { key_path: String, passphrase: Option<String> },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshSession {
    pub connection_id: String,
    pub connected: bool,
}

#[derive(Clone, Serialize)]
struct TerminalOutput {
    session_id: String,
    data: String,
}

#[derive(Clone)]
pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
    channels: Arc<Mutex<HashMap<String, Arc<Mutex<ssh2::Channel>>>>>,
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            channels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn connect(&self, connection: &SshConnection) -> anyhow::Result<String> {
        let tcp = TcpStream::connect(format!("{}:{}", connection.host, connection.port))?;
        tcp.set_nonblocking(false)?;
        
        let mut sess = Session::new()?;
        sess.set_tcp_stream(tcp);
        sess.handshake()?;

        match &connection.auth_type {
            AuthType::Password { password } => {
                sess.userauth_password(&connection.username, password)?;
            }
            AuthType::PrivateKey { key_path, passphrase } => {
                let passphrase_str = passphrase.as_deref();
                sess.userauth_pubkey_file(
                    &connection.username,
                    None,
                    Path::new(key_path),
                    passphrase_str,
                )?;
            }
        }

        if !sess.authenticated() {
            return Err(anyhow::anyhow!("Authentication failed"));
        }

        let session_id = connection.id.clone();
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(session_id.clone(), Arc::new(Mutex::new(sess)));

        Ok(session_id)
    }

    pub fn open_shell(&self, session_id: &str, app_handle: tauri::AppHandle) -> anyhow::Result<()> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?
            .clone();

        let sess = session.lock().unwrap();
        let mut channel = sess.channel_session()?;
        channel.request_pty("xterm-256color", None, Some((80, 24, 0, 0)))?;
        channel.shell()?;
        
        // Set channel to non-blocking mode
        sess.set_blocking(false);
        drop(sess);

        let channel_arc = Arc::new(Mutex::new(channel));
        let mut channels = self.channels.lock().unwrap();
        channels.insert(session_id.to_string(), channel_arc.clone());
        drop(channels);

        // Start reading output in background
        let session_id_clone = session_id.to_string();
        let channel_clone = channel_arc.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            loop {
                let mut channel_lock = match channel_clone.lock() {
                    Ok(ch) => ch,
                    Err(_) => break,
                };
                
                match channel_lock.read(&mut buffer) {
                    Ok(n) if n > 0 => {
                        let output = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let _ = app_handle.emit("terminal-output", TerminalOutput {
                            session_id: session_id_clone.clone(),
                            data: output,
                        });
                    }
                    Ok(_) => {
                        // No data available, continue
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        // No data available in non-blocking mode, continue
                    }
                    Err(_) => break,
                }
                drop(channel_lock);
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
        });

        Ok(())
    }

    pub fn write_to_shell(&self, session_id: &str, data: &str) -> anyhow::Result<()> {
        let channels = self.channels.lock().unwrap();
        let channel = channels
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Shell not found"))?;

        let mut ch = channel.lock().unwrap();
        ch.write_all(data.as_bytes())?;
        ch.flush()?;

        Ok(())
    }

    pub fn disconnect(&self, session_id: &str) -> anyhow::Result<()> {
        // Close channel first
        let mut channels = self.channels.lock().unwrap();
        if let Some(channel) = channels.remove(session_id) {
            let mut ch = channel.lock().unwrap();
            let _ = ch.close();
            let _ = ch.wait_close();
        }
        drop(channels);

        // Then close session
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(session_id) {
            let sess = session.lock().unwrap();
            let _ = sess.disconnect(None, "User disconnected", None);
        }
        Ok(())
    }

    pub fn execute_command(&self, session_id: &str, command: &str) -> anyhow::Result<String> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?;

        let sess = session.lock().unwrap();
        let mut channel = sess.channel_session()?;
        channel.exec(command)?;

        let mut output = String::new();
        channel.read_to_string(&mut output)?;
        channel.wait_close()?;

        Ok(output)
    }

    pub fn is_connected(&self, session_id: &str) -> bool {
        let sessions = self.sessions.lock().unwrap();
        sessions.contains_key(session_id)
    }

    pub fn list_sessions(&self) -> Vec<String> {
        let sessions = self.sessions.lock().unwrap();
        sessions.keys().cloned().collect()
    }

    pub fn resize_pty(&self, session_id: &str, cols: u32, rows: u32) -> anyhow::Result<()> {
        let channels = self.channels.lock().unwrap();
        let channel = channels
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Shell not found"))?;

        let mut ch = channel.lock().unwrap();
        ch.request_pty_size(cols, rows, None, None)?;

        Ok(())
    }
}

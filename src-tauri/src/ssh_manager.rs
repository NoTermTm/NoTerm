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
    PrivateKey { 
        key_path: String, 
        key_content: Option<String>,
        passphrase: Option<String> 
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshSession {
    pub connection_id: String,
    pub connected: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SftpEntry {
    pub name: String,
    pub is_dir: bool,
    pub size: Option<u64>,
    pub modified: Option<u64>,
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
            AuthType::PrivateKey { key_path, key_content, passphrase } => {
                let passphrase_str = passphrase.as_deref();
                
                // 如果有 key_content，使用内存中的私钥；否则使用文件路径
                if let Some(content) = key_content {
                    if !content.is_empty() {
                        // 使用内存中的私钥
                        // 先尝试直接使用私钥内容
                        let result = sess.userauth_pubkey_memory(
                            &connection.username,
                            None,  // 不提供公钥，让 ssh2 自动提取
                            content,
                            passphrase_str,
                        );
                        
                        if let Err(e) = result {
                            // 如果失败，返回更详细的错误信息
                            return Err(anyhow::anyhow!(
                                "Private key authentication failed: {}. Please check: 1) Key format (must be valid PEM), 2) Passphrase if key is encrypted, 3) Username is correct",
                                e
                            ));
                        }
                    } else {
                        // key_content 为空，使用 key_path
                        if key_path.is_empty() {
                            return Err(anyhow::anyhow!("Both key_path and key_content are empty"));
                        }
                        sess.userauth_pubkey_file(
                            &connection.username,
                            None,
                            Path::new(key_path),
                            passphrase_str,
                        )?;
                    }
                } else {
                    // 没有 key_content，使用 key_path
                    if key_path.is_empty() {
                        return Err(anyhow::anyhow!("key_path is empty"));
                    }
                    sess.userauth_pubkey_file(
                        &connection.username,
                        None,
                        Path::new(key_path),
                        passphrase_str,
                    )?;
                }
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

    pub fn sftp_list_dir(&self, session_id: &str, path: &str) -> anyhow::Result<Vec<SftpEntry>> {
        let sessions = self.sessions.lock().unwrap();
        let session = sessions
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Session not found"))?
            .clone();
        drop(sessions);

        let mut sess = session.lock().unwrap();
        // SFTP initialization needs blocking mode to avoid WouldBlock.
        sess.set_blocking(true);
        let sftp = sess.sftp()?;
        sess.set_blocking(false);

        let clean_path = if path.trim().is_empty() { "." } else { path.trim() };
        let entries = sftp.readdir(Path::new(clean_path))?;

        let mut output: Vec<SftpEntry> = entries
            .into_iter()
            .filter_map(|(p, stat)| {
                let name = p.file_name()?.to_string_lossy().to_string();
                if name.is_empty() || name == "." || name == ".." {
                    return None;
                }

                Some(SftpEntry {
                    name,
                    is_dir: stat.is_dir(),
                    size: stat.size,
                    modified: stat.mtime,
                })
            })
            .collect();

        output.sort_by(|a, b| {
            match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });

        Ok(output)
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

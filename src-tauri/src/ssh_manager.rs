use serde::{Deserialize, Serialize};
use ssh2::Session;
use ssh2::FileStat;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::path::Path;
use std::time::Duration;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub encoding: Option<String>,
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
    pub perm: Option<u32>,
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
    sftp_sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>, // 独立的 SFTP 会话
    connections: Arc<Mutex<HashMap<String, SshConnection>>>, // 存储连接信息
}

impl SshManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            channels: Arc::new(Mutex::new(HashMap::new())),
            sftp_sessions: Arc::new(Mutex::new(HashMap::new())),
            connections: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    // 辅助方法：创建并认证 SSH 会话
    fn create_authenticated_session(&self, connection: &SshConnection) -> anyhow::Result<Session> {
        let addr = format!("{}:{}", connection.host, connection.port)
            .to_socket_addrs()?
            .next()
            .ok_or_else(|| anyhow::anyhow!("Failed to resolve host: {}", connection.host))?;

        let tcp = TcpStream::connect_timeout(&addr, Duration::from_secs(10))
            .map_err(|e| anyhow::anyhow!("Connection timeout or failed to connect to {}:{} - {}", connection.host, connection.port, e))?;

        tcp.set_read_timeout(Some(Duration::from_secs(30)))?;
        tcp.set_write_timeout(Some(Duration::from_secs(30)))?;
        tcp.set_nonblocking(false)?;

        let mut sess = Session::new()?;
        sess.set_tcp_stream(tcp);
        sess.set_timeout(30000); // 30秒超时
        sess.handshake()
            .map_err(|e| anyhow::anyhow!("SSH handshake failed: {}", e))?;

        match &connection.auth_type {
            AuthType::Password { password } => {
                sess.userauth_password(&connection.username, password)?;
            }
            AuthType::PrivateKey { key_path, key_content, passphrase } => {
                let passphrase_str = passphrase.as_deref();

                if let Some(content) = key_content {
                    if !content.is_empty() {
                        let result = sess.userauth_pubkey_memory(
                            &connection.username,
                            None,
                            content,
                            passphrase_str,
                        );

                        if let Err(e) = result {
                            return Err(anyhow::anyhow!(
                                "Private key authentication failed: {}. Please check: 1) Key format (must be valid PEM), 2) Passphrase if key is encrypted, 3) Username is correct",
                                e
                            ));
                        }
                    } else {
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

        Ok(sess)
    }

    pub fn connect(&self, connection: &SshConnection) -> anyhow::Result<String> {
        let sess = self.create_authenticated_session(connection)?;

        let session_id = connection.id.clone();

        // 存储连接信息（用于后续创建 SFTP 会话）
        let mut connections = self.connections.lock().unwrap();
        connections.insert(session_id.clone(), connection.clone());
        drop(connections);

        // 存储 shell 会话
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
        // Close SFTP session first
        let mut sftp_sessions = self.sftp_sessions.lock().unwrap();
        if let Some(sftp_session) = sftp_sessions.remove(session_id) {
            let sess = sftp_session.lock().unwrap();
            let _ = sess.disconnect(None, "User disconnected", None);
        }
        drop(sftp_sessions);

        // Close shell channel
        let mut channels = self.channels.lock().unwrap();
        if let Some(channel) = channels.remove(session_id) {
            let mut ch = channel.lock().unwrap();
            let _ = ch.close();
            let _ = ch.wait_close();
        }
        drop(channels);

        // Close shell session
        let mut sessions = self.sessions.lock().unwrap();
        if let Some(session) = sessions.remove(session_id) {
            let sess = session.lock().unwrap();
            let _ = sess.disconnect(None, "User disconnected", None);
        }
        drop(sessions);

        // Remove connection info
        let mut connections = self.connections.lock().unwrap();
        connections.remove(session_id);

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

    fn get_or_create_sftp(&self, session_id: &str) -> anyhow::Result<Arc<Mutex<Session>>> {
        // 先检查是否已经有缓存的 SFTP 会话
        {
            let sftp_sessions = self.sftp_sessions.lock().unwrap();
            if let Some(session) = sftp_sessions.get(session_id) {
                // 检查会话是否仍然有效
                let sess = session.lock().unwrap();
                if sess.authenticated() {
                    return Ok(session.clone());
                }
                // 如果会话无效，继续创建新的
            }
        }

        // 获取连接信息
        let connections = self.connections.lock().unwrap();
        let connection = connections
            .get(session_id)
            .ok_or_else(|| anyhow::anyhow!("Connection info not found for session: {}", session_id))?
            .clone();
        drop(connections);

        // 创建新的独立 SSH 会话专门用于 SFTP
        let sess = self.create_authenticated_session(&connection)?;

        // 设置为阻塞模式（SFTP 需要）
        sess.set_blocking(true);
        sess.set_timeout(30000);

        let session_arc = Arc::new(Mutex::new(sess));

        // 缓存 SFTP 会话
        let mut sftp_sessions = self.sftp_sessions.lock().unwrap();
        sftp_sessions.insert(session_id.to_string(), session_arc.clone());

        Ok(session_arc)
    }

    pub fn sftp_list_dir(&self, session_id: &str, path: &str) -> anyhow::Result<Vec<SftpEntry>> {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess.sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        let clean_path = if path.trim().is_empty() { "." } else { path.trim() };

        // 规范化路径以检查是否在根目录
        let normalized_path = Path::new(clean_path);
        let is_root = clean_path == "/" || clean_path == "." || clean_path.is_empty();

        let entries = sftp.readdir(normalized_path)
            .map_err(|e| anyhow::anyhow!("Failed to read directory '{}': {}", clean_path, e))?;

        let mut output: Vec<SftpEntry> = entries
            .into_iter()
            .filter_map(|(p, stat)| {
                let name = p.file_name()?.to_string_lossy().to_string();
                if name.is_empty() || name == "." {
                    return None;
                }
                // 过滤掉原始的 ".." 条目，稍后手动添加
                if name == ".." {
                    return None;
                }

                Some(SftpEntry {
                    name,
                    is_dir: stat.is_dir(),
                    size: stat.size,
                    modified: stat.mtime,
                    perm: stat.perm,
                })
            })
            .collect();

        // 如果不在根目录，添加 ".." 条目用于返回上级
        if !is_root {
            output.insert(0, SftpEntry {
                name: "..".to_string(),
                is_dir: true,
                size: None,
                modified: None,
                perm: None,
            });
        }

        output.sort_by(|a, b| {
            // ".." 始终排在最前面
            if a.name == ".." {
                return std::cmp::Ordering::Less;
            }
            if b.name == ".." {
                return std::cmp::Ordering::Greater;
            }
            // 文件夹在前，文件在后
            match (a.is_dir, b.is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
            }
        });

        Ok(output)
    }

    pub fn sftp_rename(&self, session_id: &str, from_path: &str, to_path: &str) -> anyhow::Result<()> {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess.sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        sftp.rename(Path::new(from_path), Path::new(to_path), None)
            .map_err(|e| anyhow::anyhow!("Failed to rename '{}': {}", from_path, e))?;

        Ok(())
    }

    pub fn sftp_chmod(&self, session_id: &str, path: &str, mode: u32) -> anyhow::Result<()> {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess.sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        let stat = FileStat {
            size: None,
            uid: None,
            gid: None,
            perm: Some(mode),
            atime: None,
            mtime: None,
        };

        sftp.setstat(Path::new(path), stat)
            .map_err(|e| anyhow::anyhow!("Failed to chmod '{}': {}", path, e))?;

        Ok(())
    }

    pub fn sftp_delete(&self, session_id: &str, path: &str, is_dir: bool) -> anyhow::Result<()> {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess.sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        if is_dir {
            sftp.rmdir(Path::new(path))
                .map_err(|e| anyhow::anyhow!("Failed to remove directory '{}': {}", path, e))?;
        } else {
            sftp.unlink(Path::new(path))
                .map_err(|e| anyhow::anyhow!("Failed to delete file '{}': {}", path, e))?;
        }

        Ok(())
    }

    pub fn sftp_mkdir(&self, session_id: &str, path: &str) -> anyhow::Result<()> {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess.sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        sftp.mkdir(Path::new(path), 0o755)
            .map_err(|e| anyhow::anyhow!("Failed to create directory '{}': {}", path, e))?;

        Ok(())
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

    pub fn sftp_download_file(&self, session_id: &str, remote_path: &str, local_path: &str) -> anyhow::Result<()> {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess.sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        // 打开远程文件
        let mut remote_file = sftp.open(Path::new(remote_path))
            .map_err(|e| anyhow::anyhow!("Failed to open remote file '{}': {}", remote_path, e))?;

        // 创建本地文件
        let mut local_file = std::fs::File::create(local_path)
            .map_err(|e| anyhow::anyhow!("Failed to create local file '{}': {}", local_path, e))?;

        // 复制数据
        std::io::copy(&mut remote_file, &mut local_file)
            .map_err(|e| anyhow::anyhow!("Failed to download file: {}", e))?;

        Ok(())
    }

    pub fn sftp_upload_file(&self, session_id: &str, local_path: &str, remote_path: &str) -> anyhow::Result<()> {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess.sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        // 打开本地文件
        let mut local_file = std::fs::File::open(local_path)
            .map_err(|e| anyhow::anyhow!("Failed to open local file '{}': {}", local_path, e))?;

        // 创建远程文件（使用写入和截断模式）
        let mut remote_file = sftp.create(Path::new(remote_path))
            .map_err(|e| anyhow::anyhow!("Failed to create remote file '{}': {}", remote_path, e))?;

        // 复制数据
        std::io::copy(&mut local_file, &mut remote_file)
            .map_err(|e| anyhow::anyhow!("Failed to upload file: {}", e))?;

        Ok(())
    }
}

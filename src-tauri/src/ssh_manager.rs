use serde::{Deserialize, Serialize};
use ssh2::Session;
use ssh2::FileStat;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{Shutdown, TcpListener, TcpStream, ToSocketAddrs};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use std::path::Path;
use std::time::Duration;

#[cfg(target_os = "windows")]
use std::fs::OpenOptions;
#[cfg(target_os = "windows")]
use std::io::ErrorKind;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::time::{SystemTime, UNIX_EPOCH};
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
#[allow(dead_code)]
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ForwardKind {
    Local,
    Remote,
    Dynamic,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForwardConfig {
    pub id: String,
    pub kind: ForwardKind,
    pub connection: SshConnection,
    pub local_bind_host: Option<String>,
    pub local_bind_port: Option<u16>,
    pub remote_bind_host: Option<String>,
    pub remote_bind_port: Option<u16>,
    pub target_host: Option<String>,
    pub target_port: Option<u16>,
}

#[derive(Clone)]
struct ForwardHandle {
    stop: Arc<AtomicBool>,
    session: Arc<Mutex<Session>>,
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
pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
    channels: Arc<Mutex<HashMap<String, Arc<Mutex<ssh2::Channel>>>>>,
    sftp_sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>, // 独立的 SFTP 会话
    connections: Arc<Mutex<HashMap<String, SshConnection>>>, // 存储连接信息
    forwards: Arc<Mutex<HashMap<String, ForwardHandle>>>, // 端口转发
}

impl SshManager {
    const LIBSSH2_ERROR_EAGAIN: i32 = -37;

    fn open_direct_tcpip(
        session: &Arc<Mutex<Session>>,
        host: &str,
        port: u16,
    ) -> anyhow::Result<ssh2::Channel> {
        for _ in 0..30 {
            let result = {
                let sess = session.lock().unwrap();
                sess.channel_direct_tcpip(host, port, None)
            };
            match result {
                Ok(channel) => return Ok(channel),
                Err(err) => {
                    if matches!(
                        err.code(),
                        ssh2::ErrorCode::Session(code) if code == Self::LIBSSH2_ERROR_EAGAIN
                    ) {
                        std::thread::sleep(Duration::from_millis(20));
                        continue;
                    }
                    return Err(anyhow::anyhow!(err));
                }
            }
        }
        Err(anyhow::anyhow!("Timed out opening direct-tcpip channel"))
    }
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            channels: Arc::new(Mutex::new(HashMap::new())),
            sftp_sessions: Arc::new(Mutex::new(HashMap::new())),
            connections: Arc::new(Mutex::new(HashMap::new())),
            forwards: Arc::new(Mutex::new(HashMap::new())),
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
        sess.set_keepalive(true, 15);

        let effective_username = if connection.username.trim().is_empty() {
            std::env::var("USER")
                .ok()
                .filter(|name| !name.trim().is_empty())
                .or_else(|| {
                    std::env::var("USERNAME")
                        .ok()
                        .filter(|name| !name.trim().is_empty())
                })
                .unwrap_or_else(|| "root".to_string())
        } else {
            connection.username.trim().to_string()
        };

        match &connection.auth_type {
            AuthType::Password { password } => {
                sess.userauth_password(&effective_username, password)?;
            }
            AuthType::PrivateKey { key_path, key_content, passphrase } => {
                let passphrase_str = passphrase.as_deref();

                if let Some(content) = key_content {
                    if !content.is_empty() {
                        if let Err(e) = userauth_pubkey_memory_compat(
                            &sess,
                            &effective_username,
                            content,
                            passphrase_str,
                        ) {
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
                            &effective_username,
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
                        &effective_username,
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

    fn spawn_keepalive_for_session(
        &self,
        session_id: String,
        session: Arc<Mutex<Session>>,
    ) {
        let sessions = self.sessions.clone();
        std::thread::spawn(move || {
            loop {
                {
                    let sessions_guard = sessions.lock().unwrap();
                    if !sessions_guard.contains_key(&session_id) {
                        break;
                    }
                }
                let wait = {
                    let sess = session.lock().unwrap();
                    match sess.keepalive_send() {
                        Ok(wait) => wait,
                        Err(err) => {
                            if matches!(err.code(), ssh2::ErrorCode::Session(code) if code == Self::LIBSSH2_ERROR_EAGAIN) {
                                1
                            } else {
                                break;
                            }
                        }
                    }
                };
                let sleep_secs = if wait == 0 { 5 } else { wait.min(60) };
                std::thread::sleep(Duration::from_secs(sleep_secs as u64));
            }
        });
    }

    fn spawn_keepalive_for_forward(
        &self,
        session: Arc<Mutex<Session>>,
        stop: Arc<AtomicBool>,
    ) {
        std::thread::spawn(move || {
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let wait = {
                    let sess = session.lock().unwrap();
                    match sess.keepalive_send() {
                        Ok(wait) => wait,
                        Err(err) => {
                            if matches!(err.code(), ssh2::ErrorCode::Session(code) if code == Self::LIBSSH2_ERROR_EAGAIN) {
                                1
                            } else {
                                break;
                            }
                        }
                    }
                };
                let sleep_secs = if wait == 0 { 5 } else { wait.min(60) };
                std::thread::sleep(Duration::from_secs(sleep_secs as u64));
            }
        });
    }

    pub fn connect(&self, connection: &SshConnection) -> anyhow::Result<String> {
        let sess = self.create_authenticated_session(connection)?;

        let session_id = connection.id.clone();
        let session_arc = Arc::new(Mutex::new(sess));

        // 存储连接信息（用于后续创建 SFTP 会话）
        let mut connections = self.connections.lock().unwrap();
        connections.insert(session_id.clone(), connection.clone());
        drop(connections);

        // 存储 shell 会话
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(session_id.clone(), session_arc.clone());
        drop(sessions);

        self.spawn_keepalive_for_session(session_id.clone(), session_arc);

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
        let app_handle = app_handle.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut disconnected_reason: Option<String> = None;
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
                        disconnected_reason = Some("eof".to_string());
                        break;
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        // No data available in non-blocking mode, continue
                    }
                    Err(e) => {
                        disconnected_reason = Some(format!("error: {}", e));
                        break;
                    }
                }
                drop(channel_lock);
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            if let Some(reason) = disconnected_reason {
                let _ = app_handle.emit("terminal-disconnected", TerminalDisconnected {
                    session_id: session_id_clone.clone(),
                    reason,
                });
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
        let mut last_error: Option<anyhow::Error> = None;

        // Use a dedicated blocking session (shared with SFTP pool) to avoid
        // "session would block" conflicts with the interactive shell session.
        for attempt in 0..2 {
            let command_session = self.get_or_create_sftp(session_id)?;

            let result = {
                let sess = command_session.lock().unwrap();
                let mut channel = sess.channel_session()?;
                channel.exec(command)?;

                let mut output = String::new();
                channel.read_to_string(&mut output)?;
                channel.wait_close()?;
                anyhow::Ok(output)
            };

            match result {
                Ok(output) => return Ok(output),
                Err(error) => {
                    last_error = Some(error);
                    if attempt == 0 {
                        // Drop cached dedicated session and recreate once.
                        let mut sftp_sessions = self.sftp_sessions.lock().unwrap();
                        sftp_sessions.remove(session_id);
                    }
                }
            }
        }

        Err(last_error.unwrap_or_else(|| anyhow::anyhow!("Failed to execute command")))
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

    pub fn start_forward(&self, config: ForwardConfig) -> anyhow::Result<()> {
        {
            let forwards = self.forwards.lock().unwrap();
            if forwards.contains_key(&config.id) {
                return Err(anyhow::anyhow!("Forward already running"));
            }
        }

        let session = self.create_authenticated_session(&config.connection)?;
        let session = Arc::new(Mutex::new(session));
        let stop = Arc::new(AtomicBool::new(false));
        self.spawn_keepalive_for_forward(session.clone(), stop.clone());

        match config.kind {
            ForwardKind::Local => {
                let bind_host = config.local_bind_host.unwrap_or_else(|| "127.0.0.1".to_string());
                let bind_port = config.local_bind_port.ok_or_else(|| anyhow::anyhow!("Local bind port missing"))?;
                let target_host = config.target_host.ok_or_else(|| anyhow::anyhow!("Target host missing"))?;
                let target_port = config.target_port.ok_or_else(|| anyhow::anyhow!("Target port missing"))?;
                self.start_local_forward(session.clone(), stop.clone(), bind_host, bind_port, target_host, target_port)?;
            }
            ForwardKind::Remote => {
                let bind_host = config.remote_bind_host.unwrap_or_else(|| "0.0.0.0".to_string());
                let bind_port = config.remote_bind_port.ok_or_else(|| anyhow::anyhow!("Remote bind port missing"))?;
                let target_host = config.target_host.ok_or_else(|| anyhow::anyhow!("Target host missing"))?;
                let target_port = config.target_port.ok_or_else(|| anyhow::anyhow!("Target port missing"))?;
                self.start_remote_forward(session.clone(), stop.clone(), bind_host, bind_port, target_host, target_port)?;
            }
            ForwardKind::Dynamic => {
                let bind_host = config.local_bind_host.unwrap_or_else(|| "127.0.0.1".to_string());
                let bind_port = config.local_bind_port.ok_or_else(|| anyhow::anyhow!("Local bind port missing"))?;
                self.start_dynamic_forward(session.clone(), stop.clone(), bind_host, bind_port)?;
            }
        }

        let mut forwards = self.forwards.lock().unwrap();
        forwards.insert(
            config.id.clone(),
            ForwardHandle {
                stop,
                session,
            },
        );
        Ok(())
    }

    pub fn stop_forward(&self, id: &str) -> anyhow::Result<()> {
        let handle = {
            let mut forwards = self.forwards.lock().unwrap();
            forwards.remove(id)
        };

        if let Some(handle) = handle {
            handle.stop.store(true, Ordering::Relaxed);
            if let Ok(sess) = handle.session.lock() {
                let _ = sess.disconnect(None, "Forward stopped", None);
            }
            Ok(())
        } else {
            Err(anyhow::anyhow!("Forward not found"))
        }
    }

    pub fn list_forwards(&self) -> Vec<String> {
        let forwards = self.forwards.lock().unwrap();
        forwards.keys().cloned().collect()
    }

    fn start_local_forward(
        &self,
        session: Arc<Mutex<Session>>,
        stop: Arc<AtomicBool>,
        bind_host: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    ) -> anyhow::Result<()> {
        let listener = TcpListener::bind((bind_host.as_str(), bind_port))?;
        listener.set_nonblocking(true)?;
        std::thread::spawn(move || {
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                match listener.accept() {
                    Ok((stream, _)) => {
                        let session = session.clone();
                        let target_host = target_host.clone();
                        let stop = stop.clone();
                        std::thread::spawn(move || {
                            if stop.load(Ordering::Relaxed) {
                                let _ = stream.shutdown(Shutdown::Both);
                                return;
                            }
                            let _ = stream.set_nonblocking(false);
                            match Self::open_direct_tcpip(&session, &target_host, target_port) {
                                Ok(channel) => Self::pipe_streams(channel, stream),
                                Err(_) => {
                                    let _ = stream.shutdown(Shutdown::Both);
                                }
                            }
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(())
    }

    fn start_dynamic_forward(
        &self,
        session: Arc<Mutex<Session>>,
        stop: Arc<AtomicBool>,
        bind_host: String,
        bind_port: u16,
    ) -> anyhow::Result<()> {
        let listener = TcpListener::bind((bind_host.as_str(), bind_port))?;
        listener.set_nonblocking(true)?;
        std::thread::spawn(move || {
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        let session = session.clone();
                        let stop = stop.clone();
                        std::thread::spawn(move || {
                            if stop.load(Ordering::Relaxed) {
                                let _ = stream.shutdown(Shutdown::Both);
                                return;
                            }
                            let _ = stream.set_nonblocking(false);
                            let target = match Self::socks5_handshake(&mut stream) {
                                Ok(target) => target,
                                Err(_) => {
                                    let _ = stream.shutdown(Shutdown::Both);
                                    return;
                                }
                            };
                            let _ = stream.set_read_timeout(None);
                            let _ = stream.set_write_timeout(None);
                            match Self::open_direct_tcpip(&session, &target.0, target.1) {
                                Ok(channel) => {
                                    let _ = stream.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
                                    Self::pipe_streams(channel, stream);
                                }
                                Err(_) => {
                                    let _ = stream.write_all(&[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
                                    let _ = stream.shutdown(Shutdown::Both);
                                }
                            }
                        });
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(())
    }

    fn start_remote_forward(
        &self,
        session: Arc<Mutex<Session>>,
        stop: Arc<AtomicBool>,
        bind_host: String,
        bind_port: u16,
        target_host: String,
        target_port: u16,
    ) -> anyhow::Result<()> {
        let mut listener = {
            let sess = session.lock().unwrap();
            let (listener, _) = sess.channel_forward_listen(bind_port, Some(&bind_host), None)?;
            listener
        };

        std::thread::spawn(move || {
            loop {
                if stop.load(Ordering::Relaxed) {
                    break;
                }
                let mut channel = match listener.accept() {
                    Ok(channel) => channel,
                    Err(_) => {
                        if stop.load(Ordering::Relaxed) {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(80));
                        continue;
                    }
                };
                let target_host = target_host.clone();
                let stop = stop.clone();
                std::thread::spawn(move || {
                    if stop.load(Ordering::Relaxed) {
                        let _ = channel.close();
                        return;
                    }
                    match TcpStream::connect((target_host.as_str(), target_port)) {
                        Ok(stream) => {
                            Self::pipe_streams(channel, stream);
                        }
                        Err(_) => {
                            let _ = channel.close();
                        }
                    }
                });
            }
        });
        Ok(())
    }

    fn pipe_streams(channel: ssh2::Channel, stream: TcpStream) {
        let mut channel_read = channel.clone();
        let mut channel_write = channel;
        let mut stream_read = match stream.try_clone() {
            Ok(s) => s,
            Err(_) => return,
        };
        let mut stream_write = stream;

        std::thread::spawn(move || {
            let _ = std::io::copy(&mut stream_read, &mut channel_write);
            let _ = channel_write.close();
        });

        std::thread::spawn(move || {
            let _ = std::io::copy(&mut channel_read, &mut stream_write);
            let _ = stream_write.shutdown(Shutdown::Both);
        });
    }

    fn socks5_handshake(stream: &mut TcpStream) -> anyhow::Result<(String, u16)> {
        stream.set_read_timeout(Some(Duration::from_secs(10)))?;
        stream.set_write_timeout(Some(Duration::from_secs(10)))?;

        let mut header = [0u8; 2];
        stream.read_exact(&mut header)?;
        if header[0] != 0x05 {
            return Err(anyhow::anyhow!("Unsupported SOCKS version"));
        }
        let nmethods = header[1] as usize;
        let mut methods = vec![0u8; nmethods];
        stream.read_exact(&mut methods)?;
        if !methods.contains(&0x00) {
            let _ = stream.write_all(&[0x05, 0xFF]);
            return Err(anyhow::anyhow!("No supported auth method"));
        }
        stream.write_all(&[0x05, 0x00])?;

        let mut req = [0u8; 4];
        stream.read_exact(&mut req)?;
        if req[0] != 0x05 || req[1] != 0x01 {
            let _ = stream.write_all(&[0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
            return Err(anyhow::anyhow!("Unsupported command"));
        }
        let addr_type = req[3];
        let host = match addr_type {
            0x01 => {
                let mut buf = [0u8; 4];
                stream.read_exact(&mut buf)?;
                format!("{}.{}.{}.{}", buf[0], buf[1], buf[2], buf[3])
            }
            0x03 => {
                let mut len = [0u8; 1];
                stream.read_exact(&mut len)?;
                let mut buf = vec![0u8; len[0] as usize];
                stream.read_exact(&mut buf)?;
                String::from_utf8_lossy(&buf).to_string()
            }
            0x04 => {
                let mut buf = [0u8; 16];
                stream.read_exact(&mut buf)?;
                let segments: Vec<String> = buf
                    .chunks(2)
                    .map(|chunk| format!("{:02x}{:02x}", chunk[0], chunk[1]))
                    .collect();
                segments.join(":")
            }
            _ => return Err(anyhow::anyhow!("Unsupported address type")),
        };

        let mut port_buf = [0u8; 2];
        stream.read_exact(&mut port_buf)?;
        let port = u16::from_be_bytes(port_buf);
        Ok((host, port))
    }
}

#[cfg(target_os = "windows")]
fn userauth_pubkey_memory_compat(
    sess: &Session,
    username: &str,
    content: &str,
    passphrase: Option<&str>,
) -> anyhow::Result<()> {
    let key_path = write_temp_key_file(content)?;
    let result = sess.userauth_pubkey_file(username, None, key_path.as_path(), passphrase);
    let _ = std::fs::remove_file(&key_path);
    result.map_err(|e| anyhow::anyhow!(e))
}

#[cfg(target_os = "windows")]
fn write_temp_key_file(content: &str) -> anyhow::Result<PathBuf> {
    let base = std::env::temp_dir();
    let pid = std::process::id();
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();

    for attempt in 0..6 {
        let name = format!("noterm-key-{}-{}-{}.pem", pid, nanos, attempt);
        let path = base.join(name);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(content.as_bytes())?;
                return Ok(path);
            }
            Err(err) if err.kind() == ErrorKind::AlreadyExists => continue,
            Err(err) => return Err(anyhow::anyhow!(err)),
        }
    }

    Err(anyhow::anyhow!("Failed to allocate temp key file"))
}

#[cfg(not(target_os = "windows"))]
fn userauth_pubkey_memory_compat(
    sess: &Session,
    username: &str,
    content: &str,
    passphrase: Option<&str>,
) -> anyhow::Result<()> {
    sess
        .userauth_pubkey_memory(username, None, content, passphrase)
        .map_err(|e| anyhow::anyhow!(e))
}

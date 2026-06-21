use serde::{Deserialize, Serialize};
use ssh2::FileStat;
use ssh2::Session;
use ssh2::{HashType, HostKeyType, OpenFlags, OpenType};
use std::collections::HashMap;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::net::{Shutdown, SocketAddr, TcpListener, TcpStream, ToSocketAddrs};
use std::path::Path;
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use std::time::{SystemTime, UNIX_EPOCH};

#[cfg(target_os = "windows")]
use std::io::ErrorKind;
#[cfg(target_os = "windows")]
use std::path::PathBuf;
use tauri::Emitter;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SshConnection {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub host_key_fingerprint_sha256: Option<String>,
    pub auth_type: AuthType,
    pub encoding: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshHostFingerprint {
    pub host: String,
    pub port: u16,
    pub algorithm: String,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KeepaliveConfig {
    pub enabled: bool,
    pub interval_sec: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AuthType {
    Password {
        password: String,
    },
    PrivateKey {
        key_path: String,
        key_content: Option<String>,
        passphrase: Option<String>,
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
    pool_key: String,
}

#[derive(Clone)]
struct ForwardSessionHandle {
    session: Arc<Mutex<Session>>,
    keepalive_stop: Arc<AtomicBool>,
    ref_count: usize,
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

#[derive(Clone, Serialize)]
struct TerminalDebug {
    session_id: String,
    level: String,
    message: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ControlledCommandResult {
    pub exit_code: i32,
    pub stdout: String,
    pub stderr: String,
    pub duration_ms: u64,
    pub timed_out: bool,
}

#[derive(Clone)]
pub struct SshManager {
    sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
    channels: Arc<Mutex<HashMap<String, Arc<Mutex<ssh2::Channel>>>>>,
    shell_op_locks: Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
    sftp_sessions: Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>, // 独立的 SFTP 会话
    connections: Arc<Mutex<HashMap<String, SshConnection>>>,         // 存储连接信息
    connect_attempts: Arc<Mutex<HashMap<String, String>>>,
    forwards: Arc<Mutex<HashMap<String, ForwardHandle>>>, // 端口转发
    forward_sessions: Arc<Mutex<HashMap<String, ForwardSessionHandle>>>,
    transfer_cancels: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

impl SshManager {
    const LIBSSH2_ERROR_EAGAIN: i32 = -37;
    const SSH_HANDSHAKE_ATTEMPTS: usize = 3;
    const SSH_SESSION_TIMEOUT_MS: u32 = 8_000;
    const SSH_INTERACTIVE_SLICE_MS: u32 = 15;
    #[cfg(not(target_os = "macos"))]
    const SSH_CONNECT_TIMEOUT: Duration = Duration::from_secs(8);
    const SFTP_SESSION_TIMEOUT_MS: u32 = 120_000;
    const DEFAULT_KEEPALIVE_INTERVAL_SEC: u32 = 15;

    #[cfg(test)]
    fn run_io_with_timeout<T, F>(
        timeout: Duration,
        operation: F,
        timeout_message: &str,
    ) -> std::io::Result<T>
    where
        T: Send + 'static,
        F: FnOnce() -> std::io::Result<T> + Send + 'static,
    {
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            let _ = tx.send(operation());
        });

        match rx.recv_timeout(timeout) {
            Ok(result) => result,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(std::io::Error::new(
                std::io::ErrorKind::TimedOut,
                timeout_message,
            )),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => Err(std::io::Error::new(
                std::io::ErrorKind::Other,
                "I/O worker stopped before returning a result",
            )),
        }
    }

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

    fn emit_debug(
        app_handle: &tauri::AppHandle,
        session_id: &str,
        level: &str,
        message: impl Into<String>,
    ) {
        let message = message.into();
        Self::append_debug_log(session_id, level, &message);
        let _ = app_handle.emit(
            "terminal-debug",
            TerminalDebug {
                session_id: session_id.to_string(),
                level: level.to_string(),
                message,
            },
        );
    }

    fn append_debug_log(session_id: &str, level: &str, message: &str) {
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
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            channels: Arc::new(Mutex::new(HashMap::new())),
            shell_op_locks: Arc::new(Mutex::new(HashMap::new())),
            sftp_sessions: Arc::new(Mutex::new(HashMap::new())),
            connections: Arc::new(Mutex::new(HashMap::new())),
            connect_attempts: Arc::new(Mutex::new(HashMap::new())),
            forwards: Arc::new(Mutex::new(HashMap::new())),
            forward_sessions: Arc::new(Mutex::new(HashMap::new())),
            transfer_cancels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn start_connect_attempt(&self, session_id: &str, attempt_id: &str) {
        self.connect_attempts
            .lock()
            .unwrap()
            .insert(session_id.to_string(), attempt_id.to_string());
    }

    fn is_current_connect_attempt(&self, session_id: &str, attempt_id: &str) -> bool {
        self.connect_attempts
            .lock()
            .ok()
            .and_then(|attempts| attempts.get(session_id).cloned())
            .is_some_and(|current| current == attempt_id)
    }

    pub fn cancel_connect(&self, session_id: &str) -> anyhow::Result<()> {
        self.connect_attempts.lock().unwrap().remove(session_id);
        Ok(())
    }

    fn forward_session_key(connection: &SshConnection) -> String {
        serde_json::to_string(connection).unwrap_or_else(|_| {
            format!(
                "{}:{}@{}",
                connection.username, connection.port, connection.host
            )
        })
    }

    fn get_or_create_forward_session(
        &self,
        connection: &SshConnection,
    ) -> anyhow::Result<(Arc<Mutex<Session>>, String, bool, u64)> {
        let pool_key = Self::forward_session_key(connection);
        {
            let mut sessions = self.forward_sessions.lock().unwrap();
            if let Some(existing) = sessions.get_mut(&pool_key) {
                existing.ref_count = existing.ref_count.saturating_add(1);
                return Ok((existing.session.clone(), pool_key, false, 0));
            }
        }

        let started_at = Instant::now();
        let session = self.create_authenticated_session(connection, None)?;
        // Forwarding channels share one libssh2 session. They must never make
        // blocking reads while holding libssh2's internal session mutex, or a
        // single idle HTTP connection stalls every other channel.
        session.set_blocking(false);
        let session = Arc::new(Mutex::new(session));
        let keepalive_stop = Arc::new(AtomicBool::new(false));
        self.spawn_keepalive_for_forward(session.clone(), keepalive_stop.clone());
        let setup_ms = started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64;

        let mut sessions = self.forward_sessions.lock().unwrap();
        sessions.insert(
            pool_key.clone(),
            ForwardSessionHandle {
                session: session.clone(),
                keepalive_stop,
                ref_count: 1,
            },
        );
        Ok((session, pool_key, true, setup_ms))
    }

    fn release_forward_session(&self, pool_key: &str) {
        let handle = {
            let mut sessions = self.forward_sessions.lock().unwrap();
            let Some(existing) = sessions.get_mut(pool_key) else {
                return;
            };
            if existing.ref_count > 1 {
                existing.ref_count -= 1;
                return;
            }
            sessions.remove(pool_key)
        };

        if let Some(handle) = handle {
            handle.keepalive_stop.store(true, Ordering::Relaxed);
            if let Ok(sess) = handle.session.lock() {
                let _ = sess.disconnect(None, "Forward session released", None);
            }
        }
    }

    pub fn start_transfer(&self, transfer_id: &str) -> Arc<AtomicBool> {
        let cancel_token = Arc::new(AtomicBool::new(false));
        self.transfer_cancels
            .lock()
            .unwrap()
            .insert(transfer_id.to_string(), cancel_token.clone());
        cancel_token
    }

    pub fn cancel_transfer(&self, transfer_id: &str) -> bool {
        let transfers = self.transfer_cancels.lock().unwrap();
        if let Some(cancel_token) = transfers.get(transfer_id) {
            cancel_token.store(true, Ordering::SeqCst);
            return true;
        }
        false
    }

    pub fn finish_transfer(&self, transfer_id: &str, cancel_token: &Arc<AtomicBool>) {
        let mut transfers = self.transfer_cancels.lock().unwrap();
        let should_remove = transfers
            .get(transfer_id)
            .is_some_and(|active_token| Arc::ptr_eq(active_token, cancel_token));
        if should_remove {
            transfers.remove(transfer_id);
        }
    }

    fn normalize_host_fingerprint(value: &str) -> String {
        value
            .trim()
            .trim_start_matches("SHA256:")
            .chars()
            .filter(|ch| !ch.is_ascii_whitespace() && *ch != ':')
            .collect::<String>()
            .to_lowercase()
    }

    fn format_sha256_fingerprint(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            use std::fmt::Write as _;
            let _ = write!(&mut out, "{:02x}", byte);
        }
        out
    }

    fn host_key_algorithm_name(kind: HostKeyType) -> &'static str {
        match kind {
            HostKeyType::Rsa => "ssh-rsa",
            HostKeyType::Dss => "ssh-dss",
            HostKeyType::Ecdsa256 => "ecdsa-sha2-nistp256",
            HostKeyType::Ecdsa384 => "ecdsa-sha2-nistp384",
            HostKeyType::Ecdsa521 => "ecdsa-sha2-nistp521",
            HostKeyType::Ed25519 => "ssh-ed25519",
            HostKeyType::Unknown => "unknown",
        }
    }

    fn default_remote_bind_host(bind_host: Option<String>) -> String {
        bind_host
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "127.0.0.1".to_string())
    }

    fn read_session_host_fingerprint(
        session: &Session,
        host: &str,
        port: u16,
    ) -> anyhow::Result<SshHostFingerprint> {
        let (_, key_type) = session
            .host_key()
            .ok_or_else(|| anyhow::anyhow!("SSH server did not provide a host key"))?;
        let sha256 = session
            .host_key_hash(HashType::Sha256)
            .ok_or_else(|| anyhow::anyhow!("SSH server host key fingerprint is unavailable"))?;
        Ok(SshHostFingerprint {
            host: host.to_string(),
            port,
            algorithm: Self::host_key_algorithm_name(key_type).to_string(),
            sha256: Self::format_sha256_fingerprint(sha256),
        })
    }

    fn verify_expected_host_key(
        session: &Session,
        connection: &SshConnection,
    ) -> anyhow::Result<()> {
        let expected = connection
            .host_key_fingerprint_sha256
            .as_deref()
            .map(Self::normalize_host_fingerprint)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                anyhow::anyhow!(
                    "Trusted SSH host key fingerprint is missing for {}:{}",
                    connection.host.trim(),
                    connection.port
                )
            })?;
        let actual =
            Self::read_session_host_fingerprint(session, connection.host.trim(), connection.port)?;
        if Self::normalize_host_fingerprint(&actual.sha256) != expected {
            return Err(anyhow::anyhow!(
                "SSH host key verification failed for {}:{} (expected {}, got {})",
                actual.host,
                actual.port,
                expected,
                actual.sha256
            ));
        }
        Ok(())
    }

    fn create_handshaked_session(&self, connection: &SshConnection) -> anyhow::Result<Session> {
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

        let mut sess_opt: Option<Session> = None;
        let mut attempts: Vec<String> = Vec::new();
        for addr in addrs {
            // Retry a small number of banner failures, but keep interactive
            // connects bounded. A long retry window makes the desktop appear
            // frozen even though the work is on a background thread.
            for attempt_index in 0..Self::SSH_HANDSHAKE_ATTEMPTS {
                let tcp = match Self::connect_tcp_for_ssh(&addr) {
                    Ok(tcp) => tcp,
                    Err(e) => {
                        attempts.push(format!("{} connect failed: {}", addr, e));
                        break;
                    }
                };

                // libssh2's blocking flag controls its retry/wait behavior; it
                // does not change O_NONBLOCK on the underlying socket. Keep
                // the real socket non-blocking from the start so switching the
                // interactive session to non-blocking later cannot leave a
                // channel_read call blocked while it holds the shell lock.
                if let Err(e) = tcp.set_nonblocking(true) {
                    attempts.push(format!("{} set non-blocking mode failed: {}", addr, e));
                    break;
                }
                let _ = tcp.set_nodelay(true);

                let mut sess = Session::new()?;
                sess.set_tcp_stream(tcp);
                sess.set_blocking(true);
                sess.set_timeout(Self::SSH_SESSION_TIMEOUT_MS);
                match sess.handshake() {
                    Ok(()) => {
                        sess_opt = Some(sess);
                        break;
                    }
                    Err(e) => {
                        let raw = e.to_string();
                        let is_banner_error = raw.contains("Failed getting banner");
                        let reason = if is_banner_error {
                            format!(
                                "{} handshake attempt {}/{} failed: {} (target may not be SSH / SSHD not ready / network device interrupted banner)",
                                addr,
                                attempt_index + 1,
                                Self::SSH_HANDSHAKE_ATTEMPTS,
                                raw
                            )
                        } else {
                            format!(
                                "{} handshake attempt {}/{} failed: {}",
                                addr,
                                attempt_index + 1,
                                Self::SSH_HANDSHAKE_ATTEMPTS,
                                raw
                            )
                        };
                        attempts.push(reason);

                        if is_banner_error && attempt_index + 1 < Self::SSH_HANDSHAKE_ATTEMPTS {
                            let delay_ms = match attempt_index {
                                0 => 250,
                                1 => 500,
                                _ => 750,
                            };
                            std::thread::sleep(Duration::from_millis(delay_ms));
                            continue;
                        }
                        break;
                    }
                }
            }

            if sess_opt.is_some() {
                break;
            }
        }

        sess_opt.ok_or_else(|| {
            anyhow::anyhow!(
                "SSH connection failed for {}:{}; tried {} address(es): {}",
                host,
                connection.port,
                attempts.len(),
                attempts.join(" | ")
            )
        })
    }

    fn connect_tcp_for_ssh(addr: &SocketAddr) -> std::io::Result<TcpStream> {
        #[cfg(target_os = "macos")]
        {
            // A native socket is the reliable path for normal macOS installs.
            // Keep the nc proxy only as a narrow fallback for environments that
            // return EBADF while opening sockets from the app process.
            return match TcpStream::connect(addr) {
                Ok(stream) => Ok(stream),
                Err(error) if error.raw_os_error() == Some(9) => {
                    Self::connect_tcp_via_system_nc(addr)
                }
                Err(error) => Err(error),
            };
        }

        #[cfg(not(target_os = "macos"))]
        {
            TcpStream::connect_timeout(addr, Self::SSH_CONNECT_TIMEOUT)
        }
    }

    #[cfg(target_os = "macos")]
    fn connect_tcp_via_system_nc(addr: &SocketAddr) -> std::io::Result<TcpStream> {
        // Some macOS environments return EBADF when this process opens the
        // remote TCP socket directly. Route the remote socket through Apple-
        // signed /usr/bin/nc and keep libssh2 on a regular loopback TcpStream.
        //
        // In affected environments the loopback connect can also fail
        // transiently with EBADF, so retry the whole proxy setup a few times.
        let mut last_error: Option<std::io::Error> = None;
        for attempt in 0..3 {
            match Self::connect_tcp_via_system_nc_once(addr) {
                Ok(stream) => return Ok(stream),
                Err(error) => {
                    let is_bad_fd = error.raw_os_error() == Some(9);
                    last_error = Some(error);
                    if !is_bad_fd || attempt == 2 {
                        break;
                    }
                    std::thread::sleep(Duration::from_millis(150 * (attempt + 1) as u64));
                }
            }
        }

        Err(last_error.unwrap_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::Other,
                "nc TCP proxy failed without a reported error",
            )
        }))
    }

    #[cfg(target_os = "macos")]
    fn connect_tcp_via_system_nc_once(addr: &SocketAddr) -> std::io::Result<TcpStream> {
        let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| {
            std::io::Error::new(
                error.kind(),
                format!("bind loopback listener failed: {error}"),
            )
        })?;
        let local_addr = listener.local_addr().map_err(|error| {
            std::io::Error::new(
                error.kind(),
                format!("read loopback listener address failed: {error}"),
            )
        })?;
        let remote_host = addr.ip().to_string();
        let remote_port = addr.port().to_string();

        let mut child = Command::new("/usr/bin/nc")
            .arg("-v")
            .arg("-G")
            .arg("8")
            .arg(&remote_host)
            .arg(&remote_port)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                std::io::Error::new(error.kind(), format!("start nc TCP proxy failed: {error}"))
            })?;

        // Do not expose the loopback stream until nc confirms that the remote
        // connection exists. Previously this function returned immediately and
        // converted every nc connection failure into a misleading SSH timeout.
        let mut status_line = String::new();
        let status_result = child
            .stderr
            .take()
            .ok_or_else(|| std::io::Error::other("capture nc status output failed"))
            .and_then(|stderr| {
                BufReader::new(stderr)
                    .read_line(&mut status_line)
                    .map(|_| ())
            });
        if let Err(error) = status_result {
            let _ = child.kill();
            let _ = child.wait();
            return Err(std::io::Error::new(
                error.kind(),
                format!("read nc TCP proxy status failed: {error}"),
            ));
        }
        if !status_line.to_ascii_lowercase().contains("succeeded") {
            let _ = child.kill();
            let _ = child.wait();
            let message = status_line.trim();
            return Err(std::io::Error::new(
                std::io::ErrorKind::ConnectionRefused,
                if message.is_empty() {
                    "nc TCP proxy exited before connecting".to_string()
                } else {
                    format!("nc TCP proxy failed: {message}")
                },
            ));
        }

        let mut child_stdin = child
            .stdin
            .take()
            .ok_or_else(|| std::io::Error::other("open nc proxy input failed"))?;
        let mut child_stdout = child
            .stdout
            .take()
            .ok_or_else(|| std::io::Error::other("open nc proxy output failed"))?;

        let stream = TcpStream::connect(local_addr).map_err(|error| {
            let _ = child.kill();
            let _ = child.wait();
            std::io::Error::new(
                error.kind(),
                format!("connect to loopback nc proxy failed: {error}"),
            )
        })?;
        let _ = stream.set_nodelay(true);

        std::thread::spawn(move || {
            let Ok((local_stream, _)) = listener.accept() else {
                let _ = child.kill();
                let _ = child.wait();
                return;
            };
            let Ok(mut local_reader) = local_stream.try_clone() else {
                let _ = child.kill();
                let _ = child.wait();
                return;
            };
            let mut local_writer = local_stream;

            let to_child = std::thread::spawn(move || {
                let _ = std::io::copy(&mut local_reader, &mut child_stdin);
            });
            let from_child = std::thread::spawn(move || {
                let _ = std::io::copy(&mut child_stdout, &mut local_writer);
                let _ = local_writer.shutdown(Shutdown::Both);
            });

            let _ = to_child.join();
            let _ = from_child.join();
            let _ = child.kill();
            let _ = child.wait();
        });

        Ok(stream)
    }

    // 辅助方法：创建并认证 SSH 会话
    fn create_authenticated_session(
        &self,
        connection: &SshConnection,
        keepalive: Option<KeepaliveConfig>,
    ) -> anyhow::Result<Session> {
        self.create_authenticated_session_with_progress(connection, keepalive, |_, _| {})
    }

    fn create_authenticated_session_with_progress<F>(
        &self,
        connection: &SshConnection,
        keepalive: Option<KeepaliveConfig>,
        mut report_phase: F,
    ) -> anyhow::Result<Session>
    where
        F: FnMut(&str, u128),
    {
        let started_at = Instant::now();
        let sess = self.create_handshaked_session(connection)?;
        report_phase("handshake", started_at.elapsed().as_millis());

        let started_at = Instant::now();
        Self::verify_expected_host_key(&sess, connection)?;
        report_phase("host_key", started_at.elapsed().as_millis());

        let keepalive = keepalive.unwrap_or(KeepaliveConfig {
            enabled: true,
            interval_sec: Self::DEFAULT_KEEPALIVE_INTERVAL_SEC,
        });
        let keepalive_interval = keepalive.interval_sec.clamp(5, 300);
        // The first libssh2 argument is `want_reply`, not an enabled flag.
        // Unanswered keepalive replies add no value to connection liveness;
        // channel I/O remains the source of truth for disconnect detection.
        sess.set_keepalive(false, if keepalive.enabled { keepalive_interval } else { 0 });

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

        let started_at = Instant::now();
        match &connection.auth_type {
            AuthType::Password { password } => {
                sess.userauth_password(&effective_username, password)?;
            }
            AuthType::PrivateKey {
                key_path,
                key_content,
                passphrase,
            } => {
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
        report_phase("auth", started_at.elapsed().as_millis());

        Ok(sess)
    }

    pub fn get_host_fingerprint(
        &self,
        connection: &SshConnection,
    ) -> anyhow::Result<SshHostFingerprint> {
        let sess = self.create_handshaked_session(connection)?;
        Self::read_session_host_fingerprint(&sess, connection.host.trim(), connection.port)
    }

    fn spawn_keepalive_for_session(
        &self,
        session_id: String,
        session: Arc<Mutex<Session>>,
        app_handle: tauri::AppHandle,
    ) {
        let sessions = self.sessions.clone();
        let shell_op_lock = self.get_or_create_shell_op_lock(&session_id);
        std::thread::spawn(move || {
            let mut consecutive_errors = 0u8;
            loop {
                {
                    let sessions_guard = sessions.lock().unwrap();
                    if !sessions_guard.contains_key(&session_id) {
                        break;
                    }
                }
                let wait = {
                    let _op_guard = shell_op_lock.lock().unwrap();
                    let sess = session.lock().unwrap();
                    match sess.keepalive_send() {
                        Ok(wait) => {
                            consecutive_errors = 0;
                            wait
                        }
                        Err(err) => {
                            if matches!(err.code(), ssh2::ErrorCode::Session(code) if code == Self::LIBSSH2_ERROR_EAGAIN)
                            {
                                consecutive_errors = 0;
                                1
                            } else {
                                let still_registered = sessions
                                    .lock()
                                    .map(|guard| guard.contains_key(&session_id))
                                    .unwrap_or(false);
                                if !still_registered {
                                    break;
                                }
                                if !Self::is_current_session_handle(
                                    &sessions,
                                    &session_id,
                                    &session,
                                ) {
                                    break;
                                }
                                consecutive_errors = consecutive_errors.saturating_add(1);
                                if consecutive_errors >= 5 {
                                    Self::emit_debug(
                                        &app_handle,
                                        &session_id,
                                        "warn",
                                        format!("keepalive warning ignored: {}", err),
                                    );
                                }
                                1
                            }
                        }
                    }
                };
                let sleep_secs = if wait == 0 { 5 } else { wait.min(60) };
                std::thread::sleep(Duration::from_secs(sleep_secs as u64));
            }
        });
    }

    fn remove_session_state(
        sessions: &Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
        channels: &Arc<Mutex<HashMap<String, Arc<Mutex<ssh2::Channel>>>>>,
        shell_op_locks: &Arc<Mutex<HashMap<String, Arc<Mutex<()>>>>>,
        sftp_sessions: &Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
        connections: &Arc<Mutex<HashMap<String, SshConnection>>>,
        session_id: &str,
    ) {
        if let Ok(mut channels) = channels.lock() {
            channels.remove(session_id);
        }
        if let Ok(mut shell_op_locks) = shell_op_locks.lock() {
            shell_op_locks.remove(session_id);
        }
        if let Ok(mut sftp_sessions) = sftp_sessions.lock() {
            sftp_sessions.remove(session_id);
        }
        if let Ok(mut sessions) = sessions.lock() {
            sessions.remove(session_id);
        }
        if let Ok(mut connections) = connections.lock() {
            connections.remove(session_id);
        }
    }

    fn is_current_session_handle(
        sessions: &Arc<Mutex<HashMap<String, Arc<Mutex<Session>>>>>,
        session_id: &str,
        expected: &Arc<Mutex<Session>>,
    ) -> bool {
        sessions
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).cloned())
            .is_some_and(|current| Arc::ptr_eq(&current, expected))
    }

    fn is_current_channel_handle(
        channels: &Arc<Mutex<HashMap<String, Arc<Mutex<ssh2::Channel>>>>>,
        session_id: &str,
        expected: &Arc<Mutex<ssh2::Channel>>,
    ) -> bool {
        channels
            .lock()
            .ok()
            .and_then(|guard| guard.get(session_id).cloned())
            .is_some_and(|current| Arc::ptr_eq(&current, expected))
    }

    fn replace_existing_session_state(&self, session_id: &str) {
        let channel = self
            .channels
            .lock()
            .ok()
            .and_then(|mut channels| channels.remove(session_id));
        let shell_op_lock = self
            .shell_op_locks
            .lock()
            .ok()
            .and_then(|mut locks| locks.remove(session_id));
        let sftp_session = self
            .sftp_sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(session_id));
        let session = self
            .sessions
            .lock()
            .ok()
            .and_then(|mut sessions| sessions.remove(session_id));
        if let Ok(mut connections) = self.connections.lock() {
            connections.remove(session_id);
        }

        if let Some(lock) = shell_op_lock {
            let _op_guard = lock.lock().unwrap();
            if let Some(channel) = channel {
                if let Ok(mut ch) = channel.lock() {
                    let _ = ch.close();
                    let _ = ch.wait_close();
                }
            }
            if let Some(sftp_session) = sftp_session {
                if let Ok(sess) = sftp_session.lock() {
                    let _ = sess.disconnect(None, "Session replaced", None);
                }
            }
            if let Some(session) = session {
                if let Ok(sess) = session.lock() {
                    let _ = sess.disconnect(None, "Session replaced", None);
                }
            }
            return;
        }

        if let Some(channel) = channel {
            if let Ok(mut ch) = channel.lock() {
                let _ = ch.close();
                let _ = ch.wait_close();
            }
        }
        if let Some(sftp_session) = sftp_session {
            if let Ok(sess) = sftp_session.lock() {
                let _ = sess.disconnect(None, "Session replaced", None);
            }
        }
        if let Some(session) = session {
            if let Ok(sess) = session.lock() {
                let _ = sess.disconnect(None, "Session replaced", None);
            }
        }
    }

    fn get_or_create_shell_op_lock(&self, session_id: &str) -> Arc<Mutex<()>> {
        let mut locks = self.shell_op_locks.lock().unwrap();
        locks
            .entry(session_id.to_string())
            .or_insert_with(|| Arc::new(Mutex::new(())))
            .clone()
    }

    fn is_idle_shell_read_timeout(error: &std::io::Error) -> bool {
        if matches!(
            error.kind(),
            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
        ) {
            return true;
        }
        let message = error.to_string().to_lowercase();
        message.contains("would block") || message.contains("timed out")
    }

    fn spawn_keepalive_for_forward(&self, session: Arc<Mutex<Session>>, stop: Arc<AtomicBool>) {
        std::thread::spawn(move || loop {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let wait = {
                let sess = session.lock().unwrap();
                match sess.keepalive_send() {
                    Ok(wait) => wait,
                    Err(err) => {
                        if matches!(err.code(), ssh2::ErrorCode::Session(code) if code == Self::LIBSSH2_ERROR_EAGAIN)
                        {
                            1
                        } else {
                            break;
                        }
                    }
                }
            };
            let sleep_secs = if wait == 0 { 5 } else { wait.min(60) };
            std::thread::sleep(Duration::from_secs(sleep_secs as u64));
        });
    }

    pub fn connect(
        &self,
        connection: &SshConnection,
        keepalive: Option<KeepaliveConfig>,
        app_handle: tauri::AppHandle,
        attempt_id: Option<&str>,
    ) -> anyhow::Result<String> {
        let session_id = connection.id.clone();
        let keepalive = keepalive.unwrap_or(KeepaliveConfig {
            enabled: true,
            interval_sec: Self::DEFAULT_KEEPALIVE_INTERVAL_SEC,
        });
        Self::emit_debug(
            &app_handle,
            &session_id,
            "info",
            format!(
                "ssh connect start host={} port={} user={} keepalive={} interval_sec={}",
                connection.host.trim(),
                connection.port,
                connection.username.trim(),
                keepalive.enabled,
                keepalive.interval_sec
            ),
        );
        let sess = self.create_authenticated_session_with_progress(
            connection,
            Some(keepalive),
            |phase, ms| {
                Self::emit_debug(
                    &app_handle,
                    &session_id,
                    "info",
                    format!("ssh connect phase={} elapsed_ms={}", phase, ms),
                );
            },
        )?;
        if let Some(attempt_id) = attempt_id {
            if !self.is_current_connect_attempt(&session_id, attempt_id) {
                let _ = sess.disconnect(None, "Connection attempt superseded", None);
                Self::emit_debug(
                    &app_handle,
                    &session_id,
                    "info",
                    "ssh connect ignored because attempt was cancelled or superseded",
                );
                return Err(anyhow::anyhow!("SSH connection attempt cancelled"));
            }
        }
        let session_arc = Arc::new(Mutex::new(sess));

        // Reconnects reuse the same logical id. Replace prior state first so
        // stale background threads cannot later tear down the new session.
        self.replace_existing_session_state(&session_id);

        // 存储连接信息（用于后续创建 SFTP 会话）
        let mut connections = self.connections.lock().unwrap();
        connections.insert(session_id.clone(), connection.clone());
        drop(connections);

        // 存储 shell 会话
        let mut sessions = self.sessions.lock().unwrap();
        sessions.insert(session_id.clone(), session_arc.clone());
        drop(sessions);

        if keepalive.enabled {
            self.spawn_keepalive_for_session(session_id.clone(), session_arc, app_handle);
        }

        // The shell channel is opened separately; this only confirms SSH auth/session setup.
        // Logging it explicitly helps distinguish transport/auth failures from PTY failures.
        // This is intentionally terse because frontend already records reconnect state changes.
        // Keeping it here makes the copied diagnostic log self-contained.
        //
        // No user-facing output is emitted into the terminal stream.
        Ok(session_id.clone())
    }

    pub fn open_shell(
        &self,
        session_id: &str,
        app_handle: tauri::AppHandle,
        attempt_id: Option<&str>,
    ) -> anyhow::Result<()> {
        Self::emit_debug(&app_handle, session_id, "info", "ssh open shell start");
        if let Some(attempt_id) = attempt_id {
            if !self.is_current_connect_attempt(session_id, attempt_id) {
                Self::emit_debug(
                    &app_handle,
                    session_id,
                    "info",
                    "ssh open shell ignored because attempt was cancelled or superseded",
                );
                return Err(anyhow::anyhow!("SSH shell open cancelled"));
            }
        }
        let session = {
            let sessions = self.sessions.lock().unwrap();
            sessions
                .get(session_id)
                .ok_or_else(|| anyhow::anyhow!("Session not found"))?
                .clone()
        };
        let shell_op_lock = self.get_or_create_shell_op_lock(session_id);
        let mut channel = {
            let _op_guard = shell_op_lock.lock().unwrap();
            let sess = session.lock().unwrap();
            let mut channel = sess.channel_session()?;
            channel.request_pty("xterm-256color", None, Some((80, 24, 0, 0)))?;
            channel.shell()?;

            // Run one complete libssh2 operation at a time. A short blocking
            // slice avoids carrying an EAGAIN state machine from reader to
            // writer/keepalive while bounding input lock wait to one frame.
            // The actual TCP socket remains O_NONBLOCK; libssh2 performs the
            // bounded wait internally.
            sess.set_timeout(Self::SSH_INTERACTIVE_SLICE_MS);
            sess.set_blocking(true);
            channel
        };
        if let Some(attempt_id) = attempt_id {
            if !self.is_current_connect_attempt(session_id, attempt_id) {
                let _ = channel.close();
                let _ = channel.wait_close();
                Self::emit_debug(
                    &app_handle,
                    session_id,
                    "info",
                    "ssh open shell result discarded because a newer attempt took over",
                );
                return Err(anyhow::anyhow!("SSH shell open cancelled"));
            }
        }

        let channel_arc = Arc::new(Mutex::new(channel));
        let mut channels = self.channels.lock().unwrap();
        channels.insert(session_id.to_string(), channel_arc.clone());
        drop(channels);
        Self::emit_debug(&app_handle, session_id, "info", "ssh open shell success");

        // Start reading output in background
        let session_id_clone = session_id.to_string();
        let channel_clone = channel_arc.clone();
        let session_clone = session.clone();
        let shell_op_lock_clone = shell_op_lock.clone();
        let app_handle = app_handle.clone();
        let sessions_map = self.sessions.clone();
        let channels_map = self.channels.clone();
        let shell_op_locks_map = self.shell_op_locks.clone();
        let sftp_sessions_map = self.sftp_sessions.clone();
        let connections_map = self.connections.clone();
        std::thread::spawn(move || {
            let mut buffer = [0u8; 8192];
            let mut disconnected_reason: Option<String> = None;
            loop {
                // libssh2 session operations must remain serialized, but event
                // dispatch and polling sleeps must not hold this lock. Holding
                // it across those operations starves interactive writes.
                let read_result = {
                    let _op_guard = shell_op_lock_clone.lock().unwrap();
                    let mut channel_lock = match channel_clone.lock() {
                        Ok(ch) => ch,
                        Err(_) => break,
                    };
                    match channel_lock.read(&mut buffer) {
                        Ok(n) => Ok((n, n == 0 && channel_lock.eof())),
                        Err(error) => Err(error),
                    }
                };

                let sleep_ms = match read_result {
                    Ok((n, _)) if n > 0 => {
                        let output = String::from_utf8_lossy(&buffer[..n]).to_string();
                        let _ = app_handle.emit(
                            "terminal-output",
                            TerminalOutput {
                                session_id: session_id_clone.clone(),
                                data: output,
                            },
                        );
                        1
                    }
                    Ok((_, eof)) => {
                        // Only mark the shell disconnected when libssh2 reports EOF explicitly.
                        if eof {
                            Self::emit_debug(
                                &app_handle,
                                &session_id_clone,
                                "warn",
                                "ssh shell reader observed eof",
                            );
                            disconnected_reason = Some("eof".to_string());
                            break;
                        }
                        4
                    }
                    Err(e) => {
                        if Self::is_idle_shell_read_timeout(&e) {
                            4
                        } else {
                            Self::emit_debug(
                                &app_handle,
                                &session_id_clone,
                                "error",
                                format!("ssh shell reader error kind={:?}: {}", e.kind(), e),
                            );
                            disconnected_reason = Some(format!("error: {}", e));
                            break;
                        }
                    }
                };
                std::thread::sleep(std::time::Duration::from_millis(sleep_ms));
            }
            if let Some(reason) = disconnected_reason {
                if !Self::is_current_channel_handle(
                    &channels_map,
                    &session_id_clone,
                    &channel_clone,
                ) || !Self::is_current_session_handle(
                    &sessions_map,
                    &session_id_clone,
                    &session_clone,
                ) {
                    Self::emit_debug(
                        &app_handle,
                        &session_id_clone,
                        "info",
                        "ssh disconnect ignored because session/channel was already replaced",
                    );
                    return;
                }
                Self::remove_session_state(
                    &sessions_map,
                    &channels_map,
                    &shell_op_locks_map,
                    &sftp_sessions_map,
                    &connections_map,
                    &session_id_clone,
                );
                Self::emit_debug(
                    &app_handle,
                    &session_id_clone,
                    "warn",
                    format!(
                        "ssh session state removed after reader disconnect: {}",
                        reason
                    ),
                );
                let _ = app_handle.emit(
                    "terminal-disconnected",
                    TerminalDisconnected {
                        session_id: session_id_clone.clone(),
                        reason,
                    },
                );
            }
        });

        Ok(())
    }

    pub fn write_to_shell(&self, session_id: &str, data: &str) -> anyhow::Result<()> {
        fn is_retryable_shell_write_error(error: &std::io::Error) -> bool {
            if matches!(
                error.kind(),
                std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
            ) {
                return true;
            }
            let message = error.to_string().to_lowercase();
            message.contains("would block") || message.contains("timed out")
        }

        let shell_op_lock = self.get_or_create_shell_op_lock(session_id);
        let channel = {
            let channels = self.channels.lock().unwrap();
            channels
                .get(session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Shell not found"))?
        };

        let _op_guard = shell_op_lock.lock().unwrap();
        let mut ch = channel.lock().unwrap();

        // Interactive shell channel runs in non-blocking mode.
        // Treat WouldBlock/EAGAIN as transient and retry briefly, instead of
        // failing fast and triggering unnecessary frontend reconnects.
        let mut remaining = data.as_bytes();
        let deadline = Instant::now() + Duration::from_secs(8);

        while !remaining.is_empty() {
            match ch.write(remaining) {
                Ok(0) => return Err(anyhow::anyhow!("SSH write returned 0 bytes")),
                Ok(written) => {
                    remaining = &remaining[written..];
                }
                Err(err) if is_retryable_shell_write_error(&err) => {
                    if Instant::now() >= deadline {
                        return Err(anyhow::anyhow!("SSH write timed out"));
                    }
                    std::thread::sleep(Duration::from_millis(6));
                }
                Err(err) => return Err(err.into()),
            }
        }

        loop {
            match ch.flush() {
                Ok(_) => break,
                Err(err) if is_retryable_shell_write_error(&err) => {
                    if Instant::now() >= deadline {
                        return Err(anyhow::anyhow!("SSH flush timed out"));
                    }
                    std::thread::sleep(Duration::from_millis(6));
                }
                Err(err) => return Err(err.into()),
            }
        }

        Ok(())
    }

    pub fn disconnect(&self, session_id: &str) -> anyhow::Result<()> {
        let shell_op_lock = self.shell_op_locks.lock().unwrap().remove(session_id);
        let sftp_session = self.sftp_sessions.lock().unwrap().remove(session_id);
        let channel = self.channels.lock().unwrap().remove(session_id);
        let session = self.sessions.lock().unwrap().remove(session_id);
        self.connections.lock().unwrap().remove(session_id);
        self.connect_attempts.lock().unwrap().remove(session_id);

        if let Some(lock) = shell_op_lock {
            let _op_guard = lock.lock().unwrap();
            if let Some(channel) = channel {
                let mut ch = channel.lock().unwrap();
                let _ = ch.close();
                let _ = ch.wait_close();
            }
            if let Some(sftp_session) = sftp_session {
                let sess = sftp_session.lock().unwrap();
                let _ = sess.disconnect(None, "User disconnected", None);
            }
            if let Some(session) = session {
                let sess = session.lock().unwrap();
                let _ = sess.disconnect(None, "User disconnected", None);
            }
            return Ok(());
        }

        if let Some(channel) = channel {
            let mut ch = channel.lock().unwrap();
            let _ = ch.close();
            let _ = ch.wait_close();
        }
        if let Some(sftp_session) = sftp_session {
            let sess = sftp_session.lock().unwrap();
            let _ = sess.disconnect(None, "User disconnected", None);
        }
        if let Some(session) = session {
            let sess = session.lock().unwrap();
            let _ = sess.disconnect(None, "User disconnected", None);
        }

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

    pub fn execute_command_controlled(
        &self,
        session_id: &str,
        command: &str,
        timeout_sec: u64,
    ) -> anyhow::Result<ControlledCommandResult> {
        let connection = {
            let connections = self.connections.lock().unwrap();
            connections
                .get(session_id)
                .ok_or_else(|| {
                    anyhow::anyhow!("Connection info not found for session: {}", session_id)
                })?
                .clone()
        };

        let timeout_sec = timeout_sec.clamp(3, 300);
        let timeout = Duration::from_secs(timeout_sec);
        let started_at = Instant::now();

        let session = self.create_authenticated_session(&connection, None)?;
        session.set_blocking(false);
        session.set_timeout((timeout_sec * 1000) as u32);
        let deadline = started_at + timeout;

        let mut channel = loop {
            match session.channel_session() {
                Ok(channel) => break channel,
                Err(err)
                    if matches!(
                        err.code(),
                        ssh2::ErrorCode::Session(code) if code == Self::LIBSSH2_ERROR_EAGAIN
                    ) =>
                {
                    if Instant::now() >= deadline {
                        return Err(anyhow::anyhow!(
                            "SSH open channel timed out (would block), please retry"
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(12));
                }
                Err(err) => return Err(anyhow::anyhow!("Failed to open SSH channel: {}", err)),
            }
        };

        loop {
            match channel.exec(command) {
                Ok(_) => break,
                Err(err)
                    if matches!(
                        err.code(),
                        ssh2::ErrorCode::Session(code) if code == Self::LIBSSH2_ERROR_EAGAIN
                    ) =>
                {
                    if Instant::now() >= deadline {
                        return Err(anyhow::anyhow!(
                            "SSH exec timed out (would block), please retry"
                        ));
                    }
                    std::thread::sleep(Duration::from_millis(12));
                }
                Err(err) => return Err(anyhow::anyhow!("Failed to execute SSH command: {}", err)),
            }
        }

        let mut stdout = Vec::<u8>::new();
        let mut stderr = Vec::<u8>::new();
        let mut timed_out = false;
        let mut buf = [0u8; 8192];

        loop {
            let mut had_progress = false;

            loop {
                match channel.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        stdout.extend_from_slice(&buf[..n]);
                        had_progress = true;
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(err) => return Err(anyhow::anyhow!("Failed to read stdout: {}", err)),
                }
            }

            loop {
                let mut stderr_stream = channel.stderr();
                match stderr_stream.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => {
                        stderr.extend_from_slice(&buf[..n]);
                        had_progress = true;
                    }
                    Err(err) if err.kind() == std::io::ErrorKind::WouldBlock => break,
                    Err(err) => return Err(anyhow::anyhow!("Failed to read stderr: {}", err)),
                }
            }

            if channel.eof() {
                break;
            }

            if started_at.elapsed() >= timeout {
                timed_out = true;
                let _ = channel.close();
                break;
            }

            if !had_progress {
                std::thread::sleep(Duration::from_millis(12));
            }
        }

        let _ = channel.wait_close();
        let exit_code = if timed_out {
            -1
        } else {
            channel.exit_status().unwrap_or(-1)
        };

        if timed_out {
            if !stderr.is_empty() {
                stderr.extend_from_slice(b"\n");
            }
            stderr.extend_from_slice(b"Command timed out");
        }

        let _ = session.disconnect(None, "command finished", None);

        Ok(ControlledCommandResult {
            exit_code,
            stdout: String::from_utf8_lossy(&stdout).to_string(),
            stderr: String::from_utf8_lossy(&stderr).to_string(),
            duration_ms: started_at.elapsed().as_millis().min(u128::from(u64::MAX)) as u64,
            timed_out,
        })
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
            .ok_or_else(|| {
                anyhow::anyhow!("Connection info not found for session: {}", session_id)
            })?
            .clone();
        drop(connections);

        // 创建新的独立 SSH 会话专门用于 SFTP
        let sess = self.create_authenticated_session(&connection, None)?;

        // 设置为阻塞模式（SFTP 需要）
        sess.set_blocking(true);
        sess.set_timeout(Self::SFTP_SESSION_TIMEOUT_MS);

        let session_arc = Arc::new(Mutex::new(sess));

        // 缓存 SFTP 会话
        let mut sftp_sessions = self.sftp_sessions.lock().unwrap();
        sftp_sessions.insert(session_id.to_string(), session_arc.clone());

        Ok(session_arc)
    }

    pub fn sftp_list_dir(&self, session_id: &str, path: &str) -> anyhow::Result<Vec<SftpEntry>> {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess
            .sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        let clean_path = if path.trim().is_empty() {
            "."
        } else {
            path.trim()
        };

        // 规范化路径以检查是否在根目录
        let normalized_path = Path::new(clean_path);
        let is_root = clean_path == "/" || clean_path == "." || clean_path.is_empty();

        let entries = sftp
            .readdir(normalized_path)
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
            output.insert(
                0,
                SftpEntry {
                    name: "..".to_string(),
                    is_dir: true,
                    size: None,
                    modified: None,
                    perm: None,
                },
            );
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

    pub fn sftp_rename(
        &self,
        session_id: &str,
        from_path: &str,
        to_path: &str,
    ) -> anyhow::Result<()> {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess
            .sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        sftp.rename(Path::new(from_path), Path::new(to_path), None)
            .map_err(|e| anyhow::anyhow!("Failed to rename '{}': {}", from_path, e))?;

        Ok(())
    }

    pub fn sftp_chmod(&self, session_id: &str, path: &str, mode: u32) -> anyhow::Result<()> {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess
            .sftp()
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

        let sftp = sess
            .sftp()
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

        let sftp = sess
            .sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        sftp.mkdir(Path::new(path), 0o755)
            .map_err(|e| anyhow::anyhow!("Failed to create directory '{}': {}", path, e))?;

        Ok(())
    }

    pub fn resize_pty(&self, session_id: &str, cols: u32, rows: u32) -> anyhow::Result<()> {
        let shell_op_lock = self.get_or_create_shell_op_lock(session_id);
        let channel = {
            let channels = self.channels.lock().unwrap();
            channels
                .get(session_id)
                .cloned()
                .ok_or_else(|| anyhow::anyhow!("Shell not found"))?
        };

        let _op_guard = shell_op_lock.lock().unwrap();
        let mut ch = channel.lock().unwrap();
        ch.request_pty_size(cols, rows, None, None)?;

        Ok(())
    }

    pub fn sftp_download_file<F>(
        &self,
        session_id: &str,
        remote_path: &str,
        local_path: &str,
        cancel_token: Option<Arc<AtomicBool>>,
        mut on_progress: F,
    ) -> anyhow::Result<()>
    where
        F: FnMut(u64, u64) + Send,
    {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess
            .sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        // 打开远程文件
        let mut remote_file = sftp
            .open(Path::new(remote_path))
            .map_err(|e| anyhow::anyhow!("Failed to open remote file '{}': {}", remote_path, e))?;

        let total = sftp
            .stat(Path::new(remote_path))
            .ok()
            .and_then(|stat| stat.size)
            .unwrap_or(0);
        let local_existing = std::fs::metadata(local_path)
            .map(|meta| meta.len())
            .unwrap_or(0);
        let can_resume = local_existing > 0 && local_existing < total;

        let mut local_file = if can_resume {
            remote_file
                .seek(SeekFrom::Start(local_existing))
                .map_err(|e| {
                    anyhow::anyhow!("Failed to seek remote file '{}': {}", remote_path, e)
                })?;
            std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(local_path)
                .map_err(|e| anyhow::anyhow!("Failed to open local file '{}': {}", local_path, e))?
        } else {
            std::fs::File::create(local_path).map_err(|e| {
                anyhow::anyhow!("Failed to create local file '{}': {}", local_path, e)
            })?
        };

        let mut transferred: u64 = if can_resume { local_existing } else { 0 };
        let mut buf = [0u8; 64 * 1024];

        on_progress(transferred, total);
        loop {
            if cancel_token
                .as_ref()
                .is_some_and(|token| token.load(Ordering::SeqCst))
            {
                return Err(anyhow::anyhow!("transfer_cancelled"));
            }
            let read = remote_file.read(&mut buf).map_err(|e| {
                anyhow::anyhow!("Failed to read remote file '{}': {}", remote_path, e)
            })?;
            if read == 0 {
                break;
            }
            if cancel_token
                .as_ref()
                .is_some_and(|token| token.load(Ordering::SeqCst))
            {
                return Err(anyhow::anyhow!("transfer_cancelled"));
            }
            local_file.write_all(&buf[..read]).map_err(|e| {
                anyhow::anyhow!("Failed to write local file '{}': {}", local_path, e)
            })?;
            transferred = transferred.saturating_add(read as u64);
            on_progress(transferred, total);
        }
        if total > 0 && transferred < total {
            on_progress(total, total);
        }

        Ok(())
    }

    pub fn sftp_upload_file<F>(
        &self,
        session_id: &str,
        local_path: &str,
        remote_path: &str,
        use_temp_file: bool,
        mut on_progress: F,
    ) -> anyhow::Result<()>
    where
        F: FnMut(u64, u64) + Send,
    {
        let sftp_session = self.get_or_create_sftp(session_id)?;
        let sess = sftp_session.lock().unwrap();

        let sftp = sess
            .sftp()
            .map_err(|e| anyhow::anyhow!("Failed to initialize SFTP subsystem: {}", e))?;

        // 打开本地文件
        let mut local_file = std::fs::File::open(local_path)
            .map_err(|e| anyhow::anyhow!("Failed to open local file '{}': {}", local_path, e))?;

        let total = local_file.metadata().map(|meta| meta.len()).unwrap_or(0);
        let (mut remote_file, using_temp_file, mut transferred, write_target_label): (
            ssh2::File,
            bool,
            u64,
            String,
        ) = if use_temp_file {
            // Prefer upload-to-temp + rename so readers never observe partial writes.
            // Some servers allow overwriting an existing file but deny creating sibling files.
            // In that case, fall back to writing the target file directly.
            let temp_remote_path = format!("{}.part", remote_path);
            let temp_remote_path_ref = Path::new(&temp_remote_path);

            let temp_existing = sftp
                .stat(temp_remote_path_ref)
                .ok()
                .and_then(|stat| stat.size)
                .unwrap_or(0);
            let can_resume_temp = temp_existing > 0 && temp_existing < total;

            if can_resume_temp {
                local_file
                    .seek(SeekFrom::Start(temp_existing))
                    .map_err(|e| {
                        anyhow::anyhow!("Failed to seek local file '{}': {}", local_path, e)
                    })?;
                (
                    sftp.open_mode(
                        temp_remote_path_ref,
                        OpenFlags::WRITE | OpenFlags::APPEND,
                        0o644,
                        OpenType::File,
                    )
                    .map_err(|e| {
                        anyhow::anyhow!("Failed to open remote file '{}': {}", temp_remote_path, e)
                    })?,
                    true,
                    temp_existing,
                    temp_remote_path.clone(),
                )
            } else {
                match sftp.open_mode(
                    temp_remote_path_ref,
                    OpenFlags::WRITE | OpenFlags::CREATE | OpenFlags::TRUNCATE,
                    0o644,
                    OpenType::File,
                ) {
                    Ok(file) => (file, true, 0, temp_remote_path.clone()),
                    Err(temp_err) => {
                        let final_ref = Path::new(remote_path);
                        let fallback = sftp.open_mode(
                            final_ref,
                            OpenFlags::WRITE | OpenFlags::TRUNCATE,
                            0o644,
                            OpenType::File,
                        );
                        match fallback {
                            Ok(file) => (file, false, 0, remote_path.to_string()),
                            Err(final_err) => {
                                return Err(anyhow::anyhow!(
                                        "Failed to create remote file '{}': {}. Direct overwrite fallback for '{}' also failed: {}",
                                        temp_remote_path,
                                        temp_err,
                                        remote_path,
                                        final_err
                                    ));
                            }
                        }
                    }
                }
            }
        } else {
            let final_ref = Path::new(remote_path);
            let remote_existing = sftp
                .stat(final_ref)
                .ok()
                .and_then(|stat| stat.size)
                .unwrap_or(0);
            let can_resume = remote_existing > 0 && remote_existing < total;
            if can_resume {
                local_file
                    .seek(SeekFrom::Start(remote_existing))
                    .map_err(|e| {
                        anyhow::anyhow!("Failed to seek local file '{}': {}", local_path, e)
                    })?;
                (
                    sftp.open_mode(
                        final_ref,
                        OpenFlags::WRITE | OpenFlags::APPEND,
                        0o644,
                        OpenType::File,
                    )
                    .map_err(|e| {
                        anyhow::anyhow!("Failed to open remote file '{}': {}", remote_path, e)
                    })?,
                    false,
                    remote_existing,
                    remote_path.to_string(),
                )
            } else {
                (
                    sftp.open_mode(
                        final_ref,
                        OpenFlags::WRITE | OpenFlags::TRUNCATE,
                        0o644,
                        OpenType::File,
                    )
                    .map_err(|e| {
                        anyhow::anyhow!("Failed to overwrite remote file '{}': {}", remote_path, e)
                    })?,
                    false,
                    0,
                    remote_path.to_string(),
                )
            }
        };
        let mut buf = [0u8; 64 * 1024];

        on_progress(transferred, total);
        loop {
            let read = local_file.read(&mut buf).map_err(|e| {
                anyhow::anyhow!("Failed to read local file '{}': {}", local_path, e)
            })?;
            if read == 0 {
                break;
            }
            remote_file.write_all(&buf[..read]).map_err(|e| {
                anyhow::anyhow!(
                    "Failed to write remote file '{}': {}",
                    write_target_label,
                    e
                )
            })?;
            transferred = transferred.saturating_add(read as u64);
            on_progress(transferred, total);
        }
        if total > 0 && transferred < total {
            on_progress(total, total);
        }

        drop(remote_file);

        // Replace final file with temp file atomically when possible.
        if using_temp_file {
            let temp_remote_path = format!("{}.part", remote_path);
            let temp_remote_path_ref = Path::new(&temp_remote_path);
            if sftp
                .rename(temp_remote_path_ref, Path::new(remote_path), None)
                .is_err()
            {
                let _ = sftp.unlink(Path::new(remote_path));
                sftp.rename(temp_remote_path_ref, Path::new(remote_path), None)
                    .map_err(|e| {
                        anyhow::anyhow!("Failed to finalize uploaded file '{}': {}", remote_path, e)
                    })?;
            }
        }

        Ok(())
    }

    pub fn start_forward(&self, config: ForwardConfig) -> anyhow::Result<()> {
        {
            let forwards = self.forwards.lock().unwrap();
            if forwards.contains_key(&config.id) {
                return Err(anyhow::anyhow!("Forward already running"));
            }
        }

        let started_at = Instant::now();
        let (session, pool_key, created_new_session, session_setup_ms) =
            self.get_or_create_forward_session(&config.connection)?;
        let listener_stop = Arc::new(AtomicBool::new(false));

        let start_result = match config.kind {
            ForwardKind::Local => {
                let bind_host = config
                    .local_bind_host
                    .unwrap_or_else(|| "127.0.0.1".to_string());
                let bind_port = config
                    .local_bind_port
                    .ok_or_else(|| anyhow::anyhow!("Local bind port missing"))?;
                let target_host = config
                    .target_host
                    .ok_or_else(|| anyhow::anyhow!("Target host missing"))?;
                let target_port = config
                    .target_port
                    .ok_or_else(|| anyhow::anyhow!("Target port missing"))?;
                self.start_local_forward(
                    session.clone(),
                    listener_stop.clone(),
                    bind_host,
                    bind_port,
                    target_host,
                    target_port,
                )
            }
            ForwardKind::Remote => {
                let bind_host = Self::default_remote_bind_host(config.remote_bind_host);
                let bind_port = config
                    .remote_bind_port
                    .ok_or_else(|| anyhow::anyhow!("Remote bind port missing"))?;
                let target_host = config
                    .target_host
                    .ok_or_else(|| anyhow::anyhow!("Target host missing"))?;
                let target_port = config
                    .target_port
                    .ok_or_else(|| anyhow::anyhow!("Target port missing"))?;
                self.start_remote_forward(
                    session.clone(),
                    listener_stop.clone(),
                    bind_host,
                    bind_port,
                    target_host,
                    target_port,
                )
            }
            ForwardKind::Dynamic => {
                let bind_host = config
                    .local_bind_host
                    .unwrap_or_else(|| "127.0.0.1".to_string());
                let bind_port = config
                    .local_bind_port
                    .ok_or_else(|| anyhow::anyhow!("Local bind port missing"))?;
                self.start_dynamic_forward(
                    session.clone(),
                    listener_stop.clone(),
                    bind_host,
                    bind_port,
                )
            }
        };

        if let Err(err) = start_result {
            self.release_forward_session(&pool_key);
            return Err(err);
        }

        let mut forwards = self.forwards.lock().unwrap();
        forwards.insert(
            config.id.clone(),
            ForwardHandle {
                stop: listener_stop,
                pool_key,
            },
        );
        eprintln!(
            "[forward] started id={} kind={:?} reused_session={} setup_ms={} total_ms={}",
            config.id,
            config.kind,
            !created_new_session,
            session_setup_ms,
            started_at.elapsed().as_millis()
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
            self.release_forward_session(&handle.pool_key);
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
        std::thread::spawn(move || loop {
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
                            Ok(channel) => Self::pipe_streams(channel, stream, stop),
                            Err(_) => {
                                let _ = stream.shutdown(Shutdown::Both);
                            }
                        }
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
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
        std::thread::spawn(move || loop {
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
                                let _ =
                                    stream.write_all(&[0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
                                Self::pipe_streams(channel, stream, stop);
                            }
                            Err(_) => {
                                let _ =
                                    stream.write_all(&[0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]);
                                let _ = stream.shutdown(Shutdown::Both);
                            }
                        }
                    });
                }
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(_) => break,
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

        std::thread::spawn(move || loop {
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
                        Self::pipe_streams(channel, stream, stop);
                    }
                    Err(_) => {
                        let _ = channel.close();
                    }
                }
            });
        });
        Ok(())
    }

    fn pipe_streams(mut channel: ssh2::Channel, mut stream: TcpStream, stop: Arc<AtomicBool>) {
        let _ = stream.set_nodelay(true);
        let _ = stream.set_nonblocking(true);

        // Drive both directions from one short, non-blocking loop. Channel
        // clones still share libssh2's session mutex, so two blocking
        // io::copy threads are not actually full-duplex and can deadlock each
        // other. Fixed buffers also provide natural backpressure.
        let mut local_to_ssh = [0u8; 32 * 1024];
        let mut local_to_ssh_pos = 0usize;
        let mut local_to_ssh_len = 0usize;
        let mut ssh_to_local = [0u8; 32 * 1024];
        let mut ssh_to_local_pos = 0usize;
        let mut ssh_to_local_len = 0usize;
        let mut local_open = true;
        let mut remote_open = true;
        let mut sent_eof = false;

        while !stop.load(Ordering::Relaxed) {
            let mut progressed = false;

            if local_open && local_to_ssh_pos == local_to_ssh_len {
                match stream.read(&mut local_to_ssh) {
                    Ok(0) => local_open = false,
                    Ok(read) => {
                        local_to_ssh_pos = 0;
                        local_to_ssh_len = read;
                        progressed = true;
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) => {}
                    Err(_) => break,
                }
            }

            if local_to_ssh_pos < local_to_ssh_len {
                match channel.write(&local_to_ssh[local_to_ssh_pos..local_to_ssh_len]) {
                    Ok(0) => break,
                    Ok(written) => {
                        local_to_ssh_pos += written;
                        progressed = true;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }

            if !local_open && local_to_ssh_pos == local_to_ssh_len && !sent_eof {
                match channel.send_eof() {
                    Ok(()) => {
                        sent_eof = true;
                        progressed = true;
                    }
                    Err(error)
                        if matches!(
                            error.code(),
                            ssh2::ErrorCode::Session(code)
                                if code == Self::LIBSSH2_ERROR_EAGAIN
                        ) => {}
                    Err(_) => break,
                }
            }

            if remote_open && ssh_to_local_pos == ssh_to_local_len {
                match channel.read(&mut ssh_to_local) {
                    Ok(0) if channel.eof() => remote_open = false,
                    Ok(0) => {}
                    Ok(read) => {
                        ssh_to_local_pos = 0;
                        ssh_to_local_len = read;
                        progressed = true;
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                    Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                    Err(_) => break,
                }
            }

            if ssh_to_local_pos < ssh_to_local_len {
                match stream.write(&ssh_to_local[ssh_to_local_pos..ssh_to_local_len]) {
                    Ok(0) => break,
                    Ok(written) => {
                        ssh_to_local_pos += written;
                        progressed = true;
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::Interrupted
                        ) => {}
                    Err(_) => break,
                }
            }

            if !remote_open && ssh_to_local_pos == ssh_to_local_len {
                let _ = stream.shutdown(Shutdown::Write);
            }
            if !local_open
                && !remote_open
                && local_to_ssh_pos == local_to_ssh_len
                && ssh_to_local_pos == ssh_to_local_len
            {
                break;
            }

            std::thread::sleep(Duration::from_millis(if progressed { 1 } else { 3 }));
        }

        let _ = channel.close();
        let _ = stream.shutdown(Shutdown::Both);
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

#[cfg(test)]
mod tests {
    use super::{AuthType, SshConnection, SshManager};
    use std::io;
    use std::net::ToSocketAddrs;
    use std::path::Path;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn normalizes_host_fingerprints_for_comparison() {
        assert_eq!(
            SshManager::normalize_host_fingerprint("SHA256:AA:BB cc"),
            "aabbcc"
        );
    }

    #[test]
    fn defaults_remote_bind_host_to_loopback() {
        assert_eq!(
            SshManager::default_remote_bind_host(None),
            "127.0.0.1".to_string()
        );
        assert_eq!(
            SshManager::default_remote_bind_host(Some("  ".to_string())),
            "127.0.0.1".to_string()
        );
        assert_eq!(
            SshManager::default_remote_bind_host(Some("0.0.0.0".to_string())),
            "0.0.0.0".to_string()
        );
    }

    #[test]
    fn run_io_with_timeout_returns_result_before_deadline() {
        let result = SshManager::run_io_with_timeout(
            Duration::from_millis(50),
            || Ok::<_, io::Error>(123usize),
            "timed out",
        )
        .unwrap();

        assert_eq!(result, 123);
    }

    #[test]
    fn run_io_with_timeout_times_out_long_running_operation() {
        let error = SshManager::run_io_with_timeout(
            Duration::from_millis(20),
            || {
                thread::sleep(Duration::from_millis(80));
                Ok::<_, io::Error>(())
            },
            "timed out",
        )
        .unwrap_err();

        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "requires a reachable SSH endpoint to validate the nc TCP proxy path"]
    fn connects_tcp_via_system_nc_when_configured() {
        let host = std::env::var("NOTERM_E2E_TCP_HOST").expect("NOTERM_E2E_TCP_HOST missing");
        let port = std::env::var("NOTERM_E2E_TCP_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .expect("NOTERM_E2E_TCP_PORT missing or invalid");
        let addr = format!("{host}:{port}")
            .to_socket_addrs()
            .expect("failed to resolve host")
            .next()
            .expect("no address resolved");

        let stream = SshManager::connect_tcp_via_system_nc(&addr)
            .expect("nc TCP proxy should produce a local TcpStream");

        assert_eq!(
            stream
                .peer_addr()
                .expect("proxy stream should have a peer")
                .ip()
                .to_string(),
            "127.0.0.1"
        );
    }

    #[test]
    #[ignore = "requires a reachable SSH endpoint to validate libssh2 handshake"]
    fn handshakes_real_ssh_when_configured() {
        let host = std::env::var("NOTERM_E2E_HANDSHAKE_HOST")
            .expect("NOTERM_E2E_HANDSHAKE_HOST missing");
        let port = std::env::var("NOTERM_E2E_HANDSHAKE_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .expect("NOTERM_E2E_HANDSHAKE_PORT missing or invalid");

        let manager = SshManager::new();
        let session = manager
            .create_handshaked_session(&SshConnection {
                id: "e2e-handshake".to_string(),
                name: "e2e-handshake".to_string(),
                host,
                port,
                username: String::new(),
                host_key_fingerprint_sha256: None,
                auth_type: AuthType::Password {
                    password: String::new(),
                },
                encoding: None,
            })
            .expect("SSH handshake should succeed");

        assert!(session.banner_bytes().is_some());
    }

    #[test]
    #[ignore = "requires NOTERM_E2E_SSH_* environment variables and a reachable test host"]
    fn authenticates_real_ssh_with_key_path_when_configured() {
        let host = std::env::var("NOTERM_E2E_SSH_HOST").expect("NOTERM_E2E_SSH_HOST missing");
        let port = std::env::var("NOTERM_E2E_SSH_PORT")
            .ok()
            .and_then(|value| value.parse::<u16>().ok())
            .unwrap_or(22);
        let username =
            std::env::var("NOTERM_E2E_SSH_USERNAME").expect("NOTERM_E2E_SSH_USERNAME missing");
        let key_path =
            std::env::var("NOTERM_E2E_SSH_KEY_PATH").expect("NOTERM_E2E_SSH_KEY_PATH missing");
        let fingerprint = std::env::var("NOTERM_E2E_SSH_FINGERPRINT_SHA256").ok();
        assert!(Path::new(&key_path).exists(), "key path does not exist");

        let manager = SshManager::new();
        let session = manager
            .create_authenticated_session(
                &SshConnection {
                    id: "e2e-key-path".to_string(),
                    name: "e2e-key-path".to_string(),
                    host,
                    port,
                    username,
                    host_key_fingerprint_sha256: fingerprint,
                    auth_type: AuthType::PrivateKey {
                        key_path,
                        key_content: None,
                        passphrase: None,
                    },
                    encoding: None,
                },
                None,
            )
            .expect("SSH authentication should succeed");

        assert!(session.authenticated());
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
    sess.userauth_pubkey_memory(username, None, content, passphrase)
        .map_err(|e| anyhow::anyhow!(e))
}

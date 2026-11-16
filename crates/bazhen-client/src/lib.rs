//! One HTTP/1.1 exchange with the Bazhen daemon over its Unix socket, as the CLI and the hook make
//! them: the request's head, who the caller is, a deadline, and a response framed by its
//! `Content-Length`. Standard library only: the hook builds it, runs on every tool call, and builds with no network.
//!
//! Its decoders are public so the fuzz targets in `fuzz/` can reach them.

pub mod framing;

use std::env;
use std::io::{self, Read, Write};
use std::os::unix::fs::OpenOptionsExt;
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

pub use framing::Limits;
use framing::{is_truncated, read_response};

/// How long the rest of a reply may take once its first byte is in: a waiter may wait hours for a
/// reply to begin, but a daemon that stops partway through one has failed.
const REPLY_STALL: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Method {
    Get,
    Post,
}

impl Method {
    fn as_str(self) -> &'static str {
        match self {
            Self::Get => "GET",
            Self::Post => "POST",
        }
    }
}

/// Who a request comes from, as the daemon's rules need it said: the agent the caller runs inside,
/// with the token that proves it, and the paired device whose shell it runs in. All advisory but
/// the token.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Caller {
    agent_id: Option<String>,
    token: Option<String>,
    device_id: Option<String>,
}

impl Caller {
    /// The caller this process's environment says it is: `BAZHEN_AGENT_ID`, the token in the file
    /// `BAZHEN_AGENT_AUTH_FILE` names, and `BAZHEN_DEVICE_ID`. A variable set but empty is said as
    /// it is; a token that can't be read, or isn't one, is not sent at all.
    pub fn from_env() -> Self {
        Self {
            agent_id: env::var("BAZHEN_AGENT_ID").ok(),
            token: agent_token(),
            device_id: env::var("BAZHEN_DEVICE_ID").ok(),
        }
    }

    /// A caller that names no agent or device and proves itself with `token`, as the hook does,
    /// whose agent is in its request's body.
    pub fn with_token(token: Option<String>) -> Self {
        Self {
            token,
            ..Self::default()
        }
    }
}

/// The token proves who the caller is, so no log or panic message may hold it.
impl std::fmt::Debug for Caller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Caller")
            .field("agent_id", &self.agent_id)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("device_id", &self.device_id)
            .finish()
    }
}

/// The agent token in the file `BAZHEN_AGENT_AUTH_FILE` names, if it holds one. The daemon
/// refuses an agent that names itself without the token it was given, so one that can't be read
/// is sent as nothing.
pub fn agent_token() -> Option<String> {
    token_in(Path::new(&env::var_os("BAZHEN_AGENT_AUTH_FILE")?))
}

/// The most of a token file read: a token and room for the white space around it. A file holding
/// more holds no token, and is never read to its end, so a huge file costs the hook nothing.
const TOKEN_FILE_MAX: u64 = 4096;

/// The token the regular file at `path` holds, trimmed; none from anything else. A FIFO would block
/// an open until a writer came, and a device may have no end, so neither is read: the path is
/// looked at first, opened without blocking, and looked at again through the open file, which a
/// FIFO put in its place between the two can't pass.
fn token_in(path: &Path) -> Option<String> {
    if !std::fs::metadata(path).ok()?.is_file() {
        return None;
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(o_nonblock())
        .open(path)
        .ok()?;
    if !file.metadata().ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    file.take(TOKEN_FILE_MAX + 1)
        .read_to_string(&mut text)
        .ok()?;
    let token = text.trim();
    (u64::try_from(text.len()).ok()? <= TOKEN_FILE_MAX && is_agent_token(token))
        .then(|| token.to_owned())
}

/// `O_NONBLOCK` on the systems Bazhen runs on, which std doesn't name: Linux's on every
/// architecture, and macOS's. A regular file reads the same with it.
fn o_nonblock() -> i32 {
    if env::consts::OS == "macos" {
        0x0004
    } else {
        0o4000
    }
}

/// A token as the daemon mints it: 32 bytes, base64url, so 43 characters that need no escaping
/// in a header.
pub fn is_agent_token(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Why an exchange failed.
#[derive(Debug)]
pub enum Error {
    /// Nothing answered on the socket: no daemon, or one starting or stopping.
    Unreachable { socket: String, source: io::Error },
    /// The daemon took the request but didn't answer in time, or the connection broke.
    Broken(io::Error),
    /// The response ended before it said it would.
    Truncated,
    /// A header value the caller's environment gave can't go on the wire as it is.
    Header { name: &'static str },
}

impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Unreachable { socket, source } => {
                write!(f, "nothing answers on {socket}: {source}")
            }
            Self::Broken(source) => write!(f, "the daemon stopped answering: {source}"),
            Self::Truncated => f.write_str("the daemon's answer was cut short"),
            Self::Header { name } => write!(f, "{name} holds a character a header can't carry"),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Unreachable { source, .. } | Self::Broken(source) => Some(source),
            Self::Truncated | Self::Header { .. } => None,
        }
    }
}

/// What the request says beside its path and body.
fn request_head(
    method: Method,
    path: &str,
    length: usize,
    caller: &Caller,
) -> Result<String, Error> {
    let line = |name: &'static str, value: Option<&str>| match value {
        None => Ok(String::new()),
        Some(v) if is_header_value(v) => Ok(format!("{name}: {v}\r\n")),
        Some(_) => Err(Error::Header { name }),
    };
    let agent = line("Bazhen-Agent-Id", caller.agent_id.as_deref())?;
    let token = caller
        .token
        .as_deref()
        .filter(|t| is_agent_token(t))
        .map_or_default(|t| format!("Bazhen-Agent-Token: {t}\r\n"));
    let device = line("Bazhen-Device-Id", caller.device_id.as_deref())?;
    Ok(format!(
        "{} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
         {agent}{token}{device}Content-Length: {length}\r\nConnection: close\r\n\r\n",
        method.as_str()
    ))
}

/// A value a header carries as it is: printable ASCII, spaces and tabs, so none ends the line.
fn is_header_value(s: &str) -> bool {
    s.bytes().all(|b| b == b'\t' || (b' '..=b'~').contains(&b))
}

/// Sends one request and reads its whole response, which ends where its `Content-Length` says,
/// or at a head `limits` refuse. `timeout` bounds the connect's writes and the wait for the reply
/// to begin; once it has, each read gets at most the reply stall.
///
/// # Errors
///
/// `Unreachable` when nothing answers on `socket`, `Broken` when the daemon stops answering after
/// that, `Truncated` when the response ends early, and `Header` when the caller's environment
/// holds a value no header can carry.
pub fn exchange(
    socket: &Path,
    method: Method,
    path: &str,
    body: &[u8],
    caller: &Caller,
    limits: Limits,
    timeout: Duration,
) -> Result<Vec<u8>, Error> {
    let head = request_head(method, path, body.len(), caller)?;
    let mut stream = UnixStream::connect(socket).map_err(|source| Error::Unreachable {
        socket: socket.display().to_string(),
        source,
    })?;
    let response = send(&mut stream, &head, body, limits, timeout).map_err(Error::Broken)?;
    if is_truncated(&response, limits) {
        return Err(Error::Truncated);
    }
    Ok(response)
}

fn send(
    stream: &mut UnixStream,
    head: &str,
    body: &[u8],
    limits: Limits,
    timeout: Duration,
) -> io::Result<Vec<u8>> {
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    read_response(stream, limits, REPLY_STALL.min(timeout))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixListener;
    use std::thread;

    const LIMITS: Limits = Limits {
        head: 16 << 10,
        body: 1 << 20,
    };

    fn caller(agent: Option<&str>, token: Option<&str>, device: Option<&str>) -> Caller {
        Caller {
            agent_id: agent.map(str::to_owned),
            token: token.map(str::to_owned),
            device_id: device.map(str::to_owned),
        }
    }

    #[test]
    fn a_hook_post_has_the_head_it_always_had() {
        let token = "t".repeat(43);
        let head = request_head(
            Method::Post,
            "/v1/hooks",
            2,
            &Caller::with_token(Some(token.clone())),
        );
        assert_eq!(
            head.unwrap(),
            format!(
                "POST /v1/hooks HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
                 Bazhen-Agent-Token: {token}\r\nContent-Length: 2\r\nConnection: close\r\n\r\n"
            )
        );
    }

    #[test]
    fn a_tokenless_post_has_the_head_shell_reports_and_pane_titles_always_had() {
        let head = request_head(
            Method::Post,
            "/v1/shells/report",
            7,
            &Caller::with_token(None),
        );
        assert_eq!(
            head.unwrap(),
            "POST /v1/shells/report HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
             Content-Length: 7\r\nConnection: close\r\n\r\n"
        );
    }

    #[test]
    fn debug_never_prints_the_token() {
        let token = "s".repeat(43);
        let printed = format!("{:?}", caller(Some("agent_x"), Some(&token), Some("dev_y")));
        assert!(!printed.contains(&token), "{printed}");
        assert!(
            printed.contains("agent_x") && printed.contains("<redacted>"),
            "{printed}"
        );
    }

    #[test]
    fn reads_a_token_from_a_file_holding_one_and_nothing_else() {
        let dir = TempDir::new("token");
        let token = "t".repeat(43);
        let write = |name: &str, content: &[u8]| {
            let path = dir.0.join(name);
            std::fs::write(&path, content).unwrap();
            path
        };
        let padded = write("padded", format!("  {token}\n").as_bytes());
        let more = write("more", format!("{token}\nx").as_bytes());
        let huge = write("huge", &vec![b't'; 1 << 20]);
        let long = write("long", format!("{token}{}", "\n".repeat(5000)).as_bytes());
        assert_eq!(token_in(&padded), Some(token));
        for refused in [more, huge, long, dir.0.join("missing"), dir.0.clone()] {
            assert_eq!(token_in(&refused), None, "{refused:?}");
        }
        assert_eq!(token_in(Path::new("/dev/zero")), None);
    }

    #[test]
    fn reads_no_token_from_a_fifo_and_never_waits_for_a_writer() {
        let dir = TempDir::new("fifo");
        let fifo = dir.0.join("token");
        let made = std::process::Command::new("mkfifo")
            .arg(&fifo)
            .status()
            .unwrap();
        assert!(made.success());
        let (sent, read) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            // The test is gone if this send fails, so there is no one to tell.
            let _ = sent.send(token_in(&fifo));
        });
        assert_eq!(read.recv_timeout(Duration::from_secs(2)), Ok(None));
    }

    #[test]
    fn head_carries_the_agent_token_only_when_it_is_one() {
        let token = "t".repeat(43);
        let head = |t: Option<&str>| {
            request_head(Method::Post, "/v1/hooks", 2, &caller(None, t, None)).unwrap()
        };
        let forged = head(Some("x\r\nBazhen-Agent-Id: agent_y"));
        assert!(head(Some(&token)).contains(&format!("\r\nBazhen-Agent-Token: {token}\r\n")));
        assert_eq!(forged, head(None));
        assert!(!head(None).contains("Bazhen-Agent-Token"));
    }

    #[test]
    fn head_names_the_agent_and_device_as_the_environment_gave_them() {
        let token = "t".repeat(43);
        let full = caller(Some("agent_x"), Some(&token), Some("dev_y"));
        let empty = caller(Some(""), None, None);
        assert_eq!(
            request_head(Method::Get, "/v1/state", 0, &full).unwrap(),
            format!(
                "GET /v1/state HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
                 Bazhen-Agent-Id: agent_x\r\nBazhen-Agent-Token: {token}\r\n\
                 Bazhen-Device-Id: dev_y\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
        );
        assert!(
            request_head(Method::Get, "/", 0, &empty)
                .unwrap()
                .contains("\r\nBazhen-Agent-Id: \r\n")
        );
    }

    #[test]
    fn refuses_an_agent_or_device_that_would_end_its_header_line() {
        for (agent, device, name) in [
            (Some("a\r\nX: y"), None, "Bazhen-Agent-Id"),
            (None, Some("d\n"), "Bazhen-Device-Id"),
            (Some("é"), None, "Bazhen-Agent-Id"),
        ] {
            let head = request_head(Method::Get, "/", 0, &caller(agent, None, device));
            assert!(
                matches!(head, Err(Error::Header { name: n }) if n == name),
                "{agent:?}"
            );
        }
    }

    #[test]
    fn tokens_are_43_base64url_characters() {
        assert!(is_agent_token(&format!("{}xy-_", "aZ9".repeat(13))));
        for bad in [
            "",
            &"t".repeat(42),
            &"t".repeat(44),
            &format!("{}=", "t".repeat(42)),
        ] {
            assert!(!is_agent_token(bad), "{bad:?}");
        }
    }

    /// A directory of the test's own, removed when the test ends, whether or not it passed.
    struct TempDir(std::path::PathBuf);

    impl TempDir {
        fn new(name: &str) -> Self {
            static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir = env::temp_dir().join(format!("bz-client-{name}-{}-{n}", std::process::id()));
            std::fs::create_dir(&dir).unwrap();
            Self(dir)
        }

        fn socket(&self) -> std::path::PathBuf {
            self.0.join("daemon.sock")
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            // A directory left in the temp dir costs nothing a test would see.
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// A daemon that reads one request and answers it with `reply`, and hands back what it read.
    fn daemon(socket: &Path, reply: &'static [u8]) -> thread::JoinHandle<Vec<u8>> {
        let listener = UnixListener::bind(socket).unwrap();
        thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            conn.set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            let mut got = vec![0; 4096];
            let n = conn.read(&mut got).unwrap();
            got.truncate(n);
            conn.write_all(reply).unwrap();
            got
        })
    }

    #[test]
    fn exchanges_a_request_for_its_whole_response() {
        let dir = TempDir::new("ok");
        let socket = dir.socket();
        let server = daemon(&socket, b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}");
        let reply = exchange(
            &socket,
            Method::Post,
            "/v1/x",
            b"{}",
            &Caller::default(),
            LIMITS,
            Duration::from_secs(2),
        );
        let got = server.join().unwrap();
        assert_eq!(
            reply.unwrap(),
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}"
        );
        assert!(got.starts_with(b"POST /v1/x HTTP/1.1\r\n"));
        assert!(got.ends_with(b"\r\n\r\n{}"));
    }

    #[test]
    fn says_nothing_answers_where_no_daemon_listens() {
        let dir = TempDir::new("none");
        let reply = exchange(
            &dir.socket(),
            Method::Get,
            "/",
            b"",
            &Caller::default(),
            LIMITS,
            Duration::from_secs(1),
        );
        assert!(matches!(reply, Err(Error::Unreachable { .. })), "{reply:?}");
    }

    #[test]
    fn says_an_answer_that_closes_short_of_its_length_was_cut_short() {
        let dir = TempDir::new("short");
        let socket = dir.socket();
        let server = daemon(&socket, b"HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\n{}");
        let reply = exchange(
            &socket,
            Method::Get,
            "/",
            b"",
            &Caller::default(),
            LIMITS,
            Duration::from_secs(2),
        );
        server.join().unwrap();
        assert!(matches!(reply, Err(Error::Truncated)), "{reply:?}");
    }
}

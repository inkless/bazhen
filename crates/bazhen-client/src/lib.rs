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
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

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
/// with the token that proves it, the paired device whose shell it runs in, and the Codex thread
/// whose command it is. All advisory but the token.
#[derive(Clone, Default, PartialEq, Eq)]
pub struct Caller {
    agent_id: Option<String>,
    token: Option<String>,
    device_id: Option<String>,
    codex_thread: Option<String>,
}

impl Caller {
    /// The caller this process's environment says it is: `BAZHEN_AGENT_ID`, the token in the file
    /// `BAZHEN_AGENT_AUTH_FILE` names, `BAZHEN_DEVICE_ID`, and `CODEX_THREAD_ID`, which Codex sets
    /// in each command it runs. A variable set but empty is said as it is; a token that can't be
    /// read, or isn't one, is not sent at all.
    pub fn from_env() -> Self {
        Self {
            agent_id: env_text("BAZHEN_AGENT_ID"),
            token: agent_token(),
            device_id: env_text("BAZHEN_DEVICE_ID"),
            codex_thread: env_text("CODEX_THREAD_ID"),
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

    /// The headers that say who calls, each name with its value, in the order requests carry
    /// them. A token that isn't one is left out.
    ///
    /// # Errors
    ///
    /// `Header` when a value holds a character no header can carry.
    pub fn headers(&self) -> Result<Vec<(&'static str, String)>, Error> {
        let checked = |name: &'static str, value: Option<&str>| match value {
            None => Ok(None),
            Some(v) if is_header_value(v) => Ok(Some((name, v.to_owned()))),
            Some(_) => Err(Error::Header { name }),
        };
        let agent = checked("Bazhen-Agent-Id", self.agent_id.as_deref())?;
        let token = self
            .token
            .as_deref()
            .filter(|t| is_agent_token(t))
            .map(|t| ("Bazhen-Agent-Token", t.to_owned()));
        let device = checked("Bazhen-Device-Id", self.device_id.as_deref())?;
        let thread = checked("Bazhen-Codex-Thread", self.codex_thread.as_deref())?;
        Ok([agent, token, device, thread]
            .into_iter()
            .flatten()
            .collect())
    }
}

/// A variable's value as text; one that isn't UTF-8 keeps a U+FFFD where it isn't, so a header
/// refuses it rather than the caller going unnamed.
pub fn env_text(name: &str) -> Option<String> {
    env::var_os(name).map(|v| text_of(&v))
}

fn text_of(value: &std::ffi::OsStr) -> String {
    value.to_string_lossy().into_owned()
}

/// The token proves who the caller is, so no log or panic message may hold it.
impl std::fmt::Debug for Caller {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Caller")
            .field("agent_id", &self.agent_id)
            .field("token", &self.token.as_ref().map(|_| "<redacted>"))
            .field("device_id", &self.device_id)
            .field("codex_thread", &self.codex_thread)
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

/// The token the regular file at `path` holds, trimmed; none from anything else.
fn token_in(path: &Path) -> Option<String> {
    let bytes = read_regular(path, TOKEN_FILE_MAX).ok()?;
    let text = String::from_utf8(bytes).ok()?;
    let token = text.trim();
    is_agent_token(token).then(|| token.to_owned())
}

/// Why a file wasn't read.
#[derive(Debug)]
pub enum Unread {
    /// It is a FIFO, a device, a directory or anything else but a regular file.
    NotAFile,
    /// It holds more than the most that is read.
    TooLarge {
        max: u64,
    },
    Io(io::Error),
}

impl std::fmt::Display for Unread {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotAFile => f.write_str("not a regular file"),
            Self::TooLarge { max } => write!(f, "more than {max} bytes"),
            Self::Io(e) => write!(f, "{e}"),
        }
    }
}

impl std::error::Error for Unread {}

/// The bytes of the regular file at `path`, at most `max` of them. A FIFO would block an open
/// until a writer came, and a device may have no end, so neither is read: the path is looked at
/// first, opened without blocking, and looked at again through the open file, which a FIFO put in
/// its place between the two can't pass; and no more than `max` and one byte is ever read.
///
/// # Errors
///
/// `NotAFile` for anything but a regular file, `TooLarge` past `max`, and `Io` when it can't be
/// opened or read.
pub fn read_regular(path: &Path, max: u64) -> Result<Vec<u8>, Unread> {
    if !std::fs::metadata(path).map_err(Unread::Io)?.is_file() {
        return Err(Unread::NotAFile);
    }
    let file = std::fs::OpenOptions::new()
        .read(true)
        .custom_flags(o_nonblock())
        .open(path)
        .map_err(Unread::Io)?;
    if !file.metadata().map_err(Unread::Io)?.is_file() {
        return Err(Unread::NotAFile);
    }
    let mut bytes = Vec::new();
    file.take(max.saturating_add(1))
        .read_to_end(&mut bytes)
        .map_err(Unread::Io)?;
    if u64::try_from(bytes.len()).unwrap_or(u64::MAX) > max {
        return Err(Unread::TooLarge { max });
    }
    Ok(bytes)
}

/// `O_NONBLOCK` on the systems Bazhen is built for (`deny.toml`'s targets: Linux and macOS, on
/// `x86_64` and `aarch64`), which std doesn't name. Linux uses 0o4000 on x86 and arm only: alpha,
/// mips, parisc and sparc each use another value, so a port to one of them changes this. A
/// regular file reads the same with it.
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
            Self::Header { name } => {
                write!(f, "{name} holds a character outside printable ASCII")
            }
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
    let mut said = String::new();
    for (name, value) in caller.headers()? {
        said.push_str(name);
        said.push_str(": ");
        said.push_str(&value);
        said.push_str("\r\n");
    }
    Ok(format!(
        "{} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
         {said}Content-Length: {length}\r\nConnection: close\r\n\r\n",
        method.as_str()
    ))
}

/// A value a header carries as it is: printable ASCII, spaces and tabs, so none ends the line.
fn is_header_value(s: &str) -> bool {
    s.bytes().all(|b| b == b'\t' || (b' '..=b'~').contains(&b))
}

/// Sends one request and reads its whole response, which ends where its `Content-Length` says,
/// or at a head `limits` refuse. `timeout` bounds the whole exchange, the connect included; once
/// the reply has begun, each read gets at most the reply stall too.
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
    let deadline = Instant::now() + timeout;
    let head = request_head(method, path, body.len(), caller)?;
    let mut stream = connect(socket, timeout).map_err(|source| Error::Unreachable {
        socket: socket.display().to_string(),
        source,
    })?;
    let response = send(&mut stream, &head, body, limits, deadline).map_err(Error::Broken)?;
    if is_truncated(&response, limits) {
        return Err(Error::Truncated);
    }
    Ok(response)
}

/// A connection to `socket`, or a timeout: a listener whose backlog is full holds a connect until
/// it takes one, so the connect runs on a thread of its own, left behind if it never ends.
fn connect(socket: &Path, within: Duration) -> io::Result<UnixStream> {
    let (done, connected) = mpsc::channel();
    let path = socket.to_path_buf();
    thread::Builder::new()
        .name("connect".to_owned())
        .spawn(move || {
            // Nothing is waiting any more when this send fails, so there is no one to tell.
            let _ = done.send(UnixStream::connect(path));
        })?;
    connected
        .recv_timeout(within)
        .unwrap_or_else(|_| Err(io::ErrorKind::TimedOut.into()))
}

fn send(
    stream: &mut UnixStream,
    head: &str,
    body: &[u8],
    limits: Limits,
    deadline: Instant,
) -> io::Result<Vec<u8>> {
    let left = || {
        deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or(io::Error::from(io::ErrorKind::TimedOut))
    };
    // The writes don't block: a write timeout can't bound them, since BSD's starts again each
    // time the daemon frees a little room, so a daemon that reads slowly would hold the request
    // for ever. A request that fits the socket's buffer, as nearly all do, never waits here.
    stream.set_nonblocking(true)?;
    let mut pause = Duration::from_millis(1);
    for mut bytes in [head.as_bytes(), body] {
        while !bytes.is_empty() {
            match stream.write(bytes) {
                Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
                Ok(n) => {
                    bytes = bytes.get(n..).unwrap_or_default();
                    pause = Duration::from_millis(1);
                }
                Err(e) if e.kind() == io::ErrorKind::WouldBlock => {
                    std::thread::sleep(pause.min(left()?));
                    pause = (pause * 2).min(WRITE_PAUSE_MAX);
                }
                Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
                Err(e) => return Err(e),
            }
        }
    }
    stream.set_nonblocking(false)?;
    read_response(stream, limits, REPLY_STALL, deadline)
}

/// The longest a write waits before it tries again on a socket with no room.
const WRITE_PAUSE_MAX: Duration = Duration::from_millis(20);

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use std::os::unix::net::UnixListener;
    use std::thread;

    const LIMITS: Limits = Limits {
        head: 16 << 10,
        body: 1 << 20,
        chunked: false,
    };

    fn caller(agent: Option<&str>, token: Option<&str>, device: Option<&str>) -> Caller {
        Caller {
            agent_id: agent.map(str::to_owned),
            token: token.map(str::to_owned),
            device_id: device.map(str::to_owned),
            codex_thread: None,
        }
    }

    #[test]
    fn head_names_the_codex_thread_the_command_runs_in_last() {
        let thread = "01a1e0f0-593e-7ae1-9d31-769db26227fc";
        let codex = Caller {
            codex_thread: Some(thread.to_owned()),
            ..caller(None, None, Some("dev_y"))
        };
        assert_eq!(
            request_head(Method::Get, "/v1/state", 0, &codex).unwrap(),
            format!(
                "GET /v1/state HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
                 Bazhen-Device-Id: dev_y\r\nBazhen-Codex-Thread: {thread}\r\n\
                 Content-Length: 0\r\nConnection: close\r\n\r\n"
            )
        );
    }

    #[test]
    fn refuses_a_codex_thread_that_would_end_its_header_line() {
        let codex = Caller {
            codex_thread: Some("t\r\nBazhen-Agent-Id: agent_y".to_owned()),
            ..Caller::default()
        };
        assert!(matches!(
            request_head(Method::Get, "/", 0, &codex),
            Err(Error::Header {
                name: "Bazhen-Codex-Thread"
            })
        ));
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
    fn gives_up_at_its_deadline_on_a_daemon_that_reads_the_request_slowly() {
        let (mut client, mut daemon) = UnixStream::pair().unwrap();
        let reader = thread::spawn(move || {
            let mut chunk = [0; 4096];
            for _ in 0..30 {
                if matches!(daemon.read(&mut chunk), Ok(0) | Err(_)) {
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
        });
        let start = Instant::now();
        let body = vec![b'x'; 16 << 20];
        let deadline = start + Duration::from_millis(500);
        let sent = send(
            &mut client,
            "POST / HTTP/1.1\r\n\r\n",
            &body,
            LIMITS,
            deadline,
        );
        let kind = sent.map_err(|e| e.kind());
        assert!(
            matches!(
                kind,
                Err(io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock)
            ),
            "{kind:?}"
        );
        // The reader goes on for 3 s: writes each given the whole timeout again would last it out.
        assert!(
            start.elapsed() < Duration::from_millis(1500),
            "{:?}",
            start.elapsed()
        );
        drop(client);
        reader.join().unwrap();
    }

    #[test]
    fn refuses_an_agent_id_that_isnt_utf_8_rather_than_send_none() {
        use std::os::unix::ffi::OsStrExt;
        let id = text_of(std::ffi::OsStr::from_bytes(b"agent_\xff"));
        let head = request_head(Method::Get, "/", 0, &caller(Some(&id), None, None));
        assert!(
            matches!(
                head,
                Err(Error::Header {
                    name: "Bazhen-Agent-Id"
                })
            ),
            "{head:?}"
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

    fn request_is_whole(request: &[u8]) -> bool {
        let Some(end) = request.windows(4).position(|w| w == b"\r\n\r\n") else {
            return false;
        };
        let head = std::str::from_utf8(&request[..end]).unwrap();
        request.len() >= end + 4 + framing::content_length(head).unwrap_or(0)
    }

    /// A daemon that reads one request and answers it with `reply`, and hands back what it read.
    fn daemon(socket: &Path, reply: &'static [u8]) -> thread::JoinHandle<Vec<u8>> {
        let listener = UnixListener::bind(socket).unwrap();
        thread::spawn(move || {
            let (mut conn, _) = listener.accept().unwrap();
            conn.set_read_timeout(Some(Duration::from_millis(500)))
                .unwrap();
            // The whole request, head and body, before answering, as the daemon reads it.
            let mut got = Vec::new();
            let mut chunk = [0; 4096];
            while !request_is_whole(&got) {
                let n = conn.read(&mut chunk).unwrap();
                assert!(n > 0, "the request ended early");
                got.extend_from_slice(&chunk[..n]);
            }
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

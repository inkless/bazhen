//! A call to the daemon: one request over its socket, as the caller this process's environment
//! names, and its answer read as the message the call expects.

use std::os::unix::net::UnixStream;
use std::path::{Path, PathBuf};
use std::time::Duration;

use bazhen_client::{Caller, Error, Method, exchange};
use bazhen_protocol::daemon::HealthStatus;
use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use tungstenite::WebSocket;
use tungstenite::handshake::HandshakeError;
use tungstenite::handshake::client::Request;

use crate::reply::{LIMITS, Unread, decode};

/// How long a call may take: a daemon that holds one this long is wedged, and not answering.
pub(crate) const CALL: Duration = Duration::from_secs(5);
/// How long a daemon that is up takes to answer its health.
const PROBE: Duration = Duration::from_secs(2);
/// How much longer than the daemon may hold a wait the call is given to come back.
pub(crate) const WAIT_MARGIN: Duration = Duration::from_secs(5);

/// What a reply this build can't read means, when the daemon gave it as a success.
pub(crate) const ANOTHER_BUILD: &str =
    "the daemon runs another build of Bazhen: restart it with `bazhen stop`, then `bazhen start`";

/// All a probe reads of `/v1/health`, so a daemon of another build still answers it.
#[derive(Deserialize)]
struct Answering {
    status: HealthStatus,
}

/// Why a call came to nothing.
#[derive(Debug)]
pub(crate) enum Failed {
    /// Nothing answers on the socket, or the daemon stopped answering.
    NotRunning,
    /// The daemon answered, but not with what the call expects.
    Refused(String),
    /// The daemon refused the call, with this status and body.
    Rejected(Rejection),
    /// The environment holds a value no request can carry.
    Unsendable(String),
}

/// A call the daemon refused: the path, and the status and body it answered with.
#[derive(Debug)]
pub(crate) struct Rejection {
    pub(crate) path: String,
    pub(crate) status: u16,
    pub(crate) body: String,
}

impl Rejection {
    /// Whether the daemon refused the call as `busy`: a close that would end what runs.
    pub(crate) fn busy(&self) -> bool {
        self.status == 409
            && serde_json::from_str::<serde_json::Value>(&self.body)
                .is_ok_and(|b| b.get("error").and_then(serde_json::Value::as_str) == Some("busy"))
    }
}

impl std::fmt::Display for Rejection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: HTTP {}: {}", self.path, self.status, self.body)
    }
}

/// The daemon at a socket, called as this process's environment names the caller.
#[derive(Debug)]
pub(crate) struct Daemon {
    socket: PathBuf,
    caller: Caller,
}

impl Daemon {
    /// The WebSocket at `path`, its handshake bounded by `within`; a refusal says `refused` and
    /// its status when it gives no reason.
    pub(crate) fn upgrade(
        &self,
        path: &str,
        refused: &str,
        within: Duration,
    ) -> Result<WebSocket<UnixStream>, Failed> {
        upgrade(&self.socket, &self.caller, path, refused, within)
    }

    pub(crate) fn at(socket: impl Into<PathBuf>) -> Self {
        Self {
            socket: socket.into(),
            caller: Caller::from_env(),
        }
    }

    pub(crate) fn socket(&self) -> String {
        self.socket.display().to_string()
    }

    pub(crate) fn get<T: DeserializeOwned>(
        &self,
        path: &str,
        within: Duration,
    ) -> Result<T, Failed> {
        self.call(Method::Get, path, &[], within)
    }

    pub(crate) fn post<T: DeserializeOwned>(
        &self,
        path: &str,
        body: &impl Serialize,
        within: Duration,
    ) -> Result<T, Failed> {
        let body = serde_json::to_vec(body).map_err(|e| Failed::Unsendable(e.to_string()))?;
        self.call(Method::Post, path, &body, within)
    }

    /// A POST with no body, as the commands that take no input are.
    pub(crate) fn post_empty<T: DeserializeOwned>(
        &self,
        path: &str,
        within: Duration,
    ) -> Result<T, Failed> {
        self.call(Method::Post, path, &[], within)
    }

    fn call<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: &[u8],
        within: Duration,
    ) -> Result<T, Failed> {
        let response = exchange(
            &self.socket,
            method,
            path,
            body,
            &self.caller,
            LIMITS,
            within,
        )
        .map_err(|e| match e {
            Error::Header { name } => Failed::Unsendable(format!(
                "{} holds a character outside printable ASCII",
                env_name(name)
            )),
            Error::Unreachable { .. } | Error::Broken(_) | Error::Truncated => Failed::NotRunning,
        })?;
        decode(&response, LIMITS).map_err(|e| match e {
            Unread::Garbled => Failed::NotRunning,
            // A refusal is read by its caller; a success this build can't read, or a route the
            // daemon doesn't have, came from another.
            Unread::Refused { status, body } if status < 300 || no_such_route(status, &body) => {
                Failed::Refused(format!("{path}: HTTP {status}: {body}\n{ANOTHER_BUILD}"))
            }
            Unread::Refused { status, body } => Failed::Rejected(Rejection {
                path: path.to_owned(),
                status,
                body,
            }),
        })
    }

    /// Whether a daemon answers on the socket at all. Only its status is read, so `stop` still
    /// stops a daemon of another build.
    pub(crate) fn answers(&self) -> Result<bool, Failed> {
        match self.get::<Answering>("/v1/health", PROBE) {
            Ok(Answering {
                status: HealthStatus::Ok,
            }) => Ok(true),
            Err(Failed::NotRunning) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

/// Whether a refusal is the daemon's answer to a route it doesn't have. It refuses a request on a
/// route it has with a JSON error, as a 404 for an unknown task; a route it lacks gets a 404 in
/// plain text.
fn no_such_route(status: u16, body: &str) -> bool {
    status == 404 && serde_json::from_str::<serde::de::IgnoredAny>(body).is_err()
}

/// The variable a request header comes from.
fn env_name(header: &str) -> &'static str {
    if header == "Bazhen-Device-Id" {
        "BAZHEN_DEVICE_ID"
    } else {
        "BAZHEN_AGENT_ID"
    }
}

/// A refusal's body, as far as the person needs it.
#[derive(Deserialize)]
struct Refusal {
    message: String,
}

/// The WebSocket at `path` through the daemon at `socket`, as `caller`, its reads and writes
/// bounded by `within`. A refusal says what the daemon said, else `refused` and its status.
pub(crate) fn upgrade(
    socket: &Path,
    caller: &Caller,
    path: &str,
    refused: &str,
    within: Duration,
) -> Result<WebSocket<UnixStream>, Failed> {
    let stream = UnixStream::connect(socket).map_err(|_| Failed::NotRunning)?;
    stream
        .set_read_timeout(Some(within))
        .and_then(|()| stream.set_write_timeout(Some(within)))
        .map_err(|_| Failed::NotRunning)?;
    let mut request = Request::builder()
        .uri(format!("ws://localhost{path}"))
        .header("Host", "localhost")
        .header("Connection", "Upgrade")
        .header("Upgrade", "websocket")
        .header("Sec-WebSocket-Version", "13")
        .header(
            "Sec-WebSocket-Key",
            tungstenite::handshake::client::generate_key(),
        );
    let said = caller
        .headers()
        .map_err(|e| Failed::Unsendable(e.to_string()))?;
    for (name, value) in said {
        request = request.header(name, value);
    }
    let request = request
        .body(())
        .map_err(|e| Failed::Unsendable(e.to_string()))?;
    match tungstenite::client::client(request, stream) {
        Ok((ws, _)) => Ok(ws),
        Err(HandshakeError::Failure(tungstenite::Error::Http(response))) => {
            if response.status() == 404 {
                return Err(Failed::Refused(ANOTHER_BUILD.to_owned()));
            }
            let body = response.body().as_deref().unwrap_or_default();
            let said = serde_json::from_slice::<Refusal>(body).map(|r| r.message);
            Err(Failed::Refused(said.unwrap_or_else(|_| {
                format!("{refused}: HTTP {}", response.status())
            })))
        }
        Err(_) => Err(Failed::NotRunning),
    }
}

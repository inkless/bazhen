//! A call to the daemon: one request over its socket, as the caller this process's environment
//! names, and its answer read as the message the call expects.

use std::path::PathBuf;
use std::time::Duration;

use bazhen_client::{Caller, Error, Method, exchange};
use bazhen_protocol::daemon::HealthResponse;
use serde::Serialize;
use serde::de::DeserializeOwned;

use crate::reply::{LIMITS, Unread, decode};

/// How long a call may take: a daemon that holds one this long is wedged, and not answering.
pub(crate) const CALL: Duration = Duration::from_secs(5);
/// How long a daemon that is up takes to answer its health.
const PROBE: Duration = Duration::from_secs(2);
/// How much longer than the daemon may hold a wait the call is given to come back.
pub(crate) const WAIT_MARGIN: Duration = Duration::from_secs(5);

/// Why a call came to nothing.
#[derive(Debug)]
pub(crate) enum Failed {
    /// Nothing answers on the socket, or the daemon stopped answering.
    NotRunning,
    /// The daemon answered, but not with what the call expects.
    Refused(String),
    /// The environment holds a value no request can carry.
    Unsendable(String),
}

/// The daemon at a socket, called as this process's environment names the caller.
#[derive(Debug)]
pub(crate) struct Daemon {
    socket: PathBuf,
    caller: Caller,
}

impl Daemon {
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
            Unread::Refused { status, body } => {
                Failed::Refused(format!("{path}: HTTP {status}: {body}"))
            }
        })
    }

    /// Whether a daemon answers on the socket at all.
    pub(crate) fn answers(&self) -> Result<bool, Failed> {
        match self.get::<HealthResponse>("/v1/health", PROBE) {
            Ok(_) => Ok(true),
            Err(Failed::NotRunning) => Ok(false),
            Err(e) => Err(e),
        }
    }
}

/// The variable a request header comes from.
fn env_name(header: &str) -> &'static str {
    if header == "Bazhen-Device-Id" {
        "BAZHEN_DEVICE_ID"
    } else {
        "BAZHEN_AGENT_ID"
    }
}

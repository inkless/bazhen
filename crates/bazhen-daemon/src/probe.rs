//! Whether a daemon answers on a socket, and which protocol it speaks, as start-up and `start`
//! ask before taking it (`probe` in `socket/probe.ts`).

use std::io::ErrorKind;
use std::path::Path;
use std::time::Duration;

use bazhen_client::Error;
use bazhen_client::framing::{self, Limits};

/// How long a probe waits for the daemon's answer.
const PROBE: Duration = Duration::from_secs(2);

const LIMITS: Limits = Limits {
    head: 16 * 1024,
    body: 64 * 1024,
    chunked: true,
};

/// What answers on a socket.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Answer {
    /// Nothing listens: no socket, or one no process listens on, as a daemon that ended leaves.
    Nothing,
    /// Something may hold the socket, but no answer came: `seen` says what happened instead. Not
    /// this one's to replace either.
    Silent { seen: String },
    /// Something answered, with the protocol id its health names, if it names one a build can read.
    Daemon { protocol_id: Option<String> },
}

/// Why bazhen won't start over a socket that answered `Silent`.
pub(crate) fn silence(socket: &str, seen: &str) -> String {
    format!(
        "bazhen won't start over {socket}: something may hold it, but it gave no answer ({seen})"
    )
}

/// Asks the daemon on `socket` for its health.
pub(crate) fn probe(socket: &Path) -> Answer {
    probe_within(socket, PROBE)
}

fn probe_within(socket: &Path, within: Duration) -> Answer {
    answer_of(bazhen_client::exchange(
        socket,
        bazhen_client::Method::Get,
        "/v1/health",
        b"",
        &bazhen_client::Caller::with_token(None),
        LIMITS,
        within,
    ))
}

/// Only a socket that isn't there, or that refuses, is proven free: anything else may be a daemon.
fn answer_of(response: Result<Vec<u8>, Error>) -> Answer {
    match response {
        Err(Error::Unreachable { source, .. })
            if matches!(
                source.kind(),
                ErrorKind::NotFound | ErrorKind::ConnectionRefused
            ) =>
        {
            Answer::Nothing
        }
        Err(Error::Unreachable { source, .. }) => Answer::Silent {
            seen: source.to_string(),
        },
        Err(err @ (Error::Broken(_) | Error::Header { .. })) => Answer::Silent {
            seen: err.to_string(),
        },
        Err(Error::Truncated) => Answer::Daemon { protocol_id: None },
        Ok(response) => Answer::Daemon {
            protocol_id: spoken(&response),
        },
    }
}

/// The protocol id a health response names: from a 200 whose body is JSON with a string
/// `protocolId`.
fn spoken(response: &[u8]) -> Option<String> {
    let (head, _) = framing::split_head(response)?;
    if framing::status(head)? != 200 {
        return None;
    }
    let body = framing::body(response, LIMITS)?;
    let health: serde_json::Value = serde_json::from_slice(&body).ok()?;
    health.get("protocolId")?.as_str().map(str::to_owned)
}

#[cfg(test)]
mod tests {
    use std::io;
    use std::os::unix::net::UnixListener;

    use super::*;
    use crate::testing::TempDir;

    fn silent(seen: &str) -> Answer {
        Answer::Silent {
            seen: seen.to_owned(),
        }
    }

    fn response(status: &str, body: &str) -> Vec<u8> {
        format!(
            "HTTP/1.1 {status}\r\ncontent-length: {}\r\n\r\n{body}",
            body.len()
        )
        .into_bytes()
    }

    #[test]
    fn reads_the_protocol_a_health_answer_names_and_nothing_from_any_other() {
        assert_eq!(
            [
                spoken(&response("200 OK", r#"{"status":"ok","protocolId":"abc"}"#)),
                spoken(&response("200 OK", r#"{"status":"ok"}"#)),
                spoken(&response("200 OK", r#"{"protocolId":7}"#)),
                spoken(&response("401 Unauthorized", r#"{"protocolId":"abc"}"#)),
                spoken(&response("200 OK", "not json")),
                spoken(b"garbage"),
            ],
            [Some("abc".to_owned()), None, None, None, None, None]
        );
    }

    #[test]
    fn takes_the_socket_for_free_only_where_nothing_is_or_nothing_listens() {
        let unreachable = |kind: ErrorKind| {
            answer_of(Err(Error::Unreachable {
                socket: "bazhen.sock".to_owned(),
                source: io::Error::from(kind),
            }))
        };
        assert_eq!(
            [
                unreachable(ErrorKind::NotFound),
                unreachable(ErrorKind::ConnectionRefused),
                unreachable(ErrorKind::TimedOut),
                unreachable(ErrorKind::WouldBlock),
                unreachable(ErrorKind::PermissionDenied),
                answer_of(Err(Error::Broken(ErrorKind::TimedOut.into()))),
                answer_of(Err(Error::Header { name: "x" })),
                answer_of(Err(Error::Truncated)),
                answer_of(Ok(response("404 Not Found", "{}"))),
            ],
            [
                Answer::Nothing,
                Answer::Nothing,
                silent("timed out"),
                silent("operation would block"),
                silent("permission denied"),
                silent("the daemon stopped answering: timed out"),
                silent("x holds a character outside printable ASCII"),
                Answer::Daemon { protocol_id: None },
                Answer::Daemon { protocol_id: None },
            ]
        );
    }

    #[test]
    fn nothing_answers_on_a_socket_no_one_is_at_or_listens_on() {
        let dir = TempDir::new("probe-none");
        let stale = dir.path().join("stale.sock");
        drop(UnixListener::bind(&stale).unwrap());
        assert_eq!(
            [&dir.path().join("none.sock"), &stale].map(|s| probe(s)),
            [Answer::Nothing, Answer::Nothing]
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn a_daemon_whose_backlog_is_full_is_silent() {
        let dir = TempDir::new("probe-full");
        let socket = dir.path().join("bazhen.sock");
        let _full = crate::testing::FullBacklog::at(&socket);
        assert!(
            matches!(
                probe_within(&socket, Duration::from_millis(200)),
                Answer::Silent { .. }
            ),
            "the probe took a full backlog for no daemon, or for one that answered"
        );
    }
}

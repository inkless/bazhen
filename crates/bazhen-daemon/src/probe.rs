//! Whether a daemon answers on a socket, and which protocol it speaks (`answers` and
//! `spokenProtocol` in `socket/client.ts`), as start-up and `start` ask before taking it.

use std::path::Path;
use std::time::Duration;

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
    /// Nothing: no daemon, or one starting or stopping.
    Nothing,
    /// Something, with the protocol id its health names, if it names one a build can read.
    Daemon { protocol_id: Option<String> },
}

/// Asks the daemon on `socket` for its health. Anything that answers at all counts as a daemon:
/// whatever holds the socket isn't this one's to replace.
pub(crate) fn probe(socket: &Path) -> Answer {
    let response = bazhen_client::exchange(
        socket,
        bazhen_client::Method::Get,
        "/v1/health",
        b"",
        &bazhen_client::Caller::with_token(None),
        LIMITS,
        PROBE,
    );
    match response {
        Err(bazhen_client::Error::Unreachable { .. }) => Answer::Nothing,
        Err(_) => Answer::Daemon { protocol_id: None },
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
    use super::*;

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
    fn nothing_answers_on_a_socket_no_one_listens_on() {
        let path = std::env::temp_dir().join(format!("bz-probe-none-{}.sock", std::process::id()));
        assert_eq!(probe(&path), Answer::Nothing);
    }
}

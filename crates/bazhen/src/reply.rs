//! The daemon's answer to a call, read as the message the call expects. Only a success holds one:
//! anything else is refused with the status and the body as they came, even a body that would
//! read as the message, as a refusal's does as a message whose every field may be left out.

use bazhen_client::Limits;
use bazhen_client::framing::{body, split_head, status};
use serde::de::DeserializeOwned;

/// What the CLI reads of an answer: a snapshot of a large fleet runs to megabytes, and a body
/// sent in chunks is read as any HTTP client reads one.
pub const LIMITS: Limits = Limits {
    head: 16 << 10,
    body: 64 << 20,
    chunked: true,
};

/// An answer this CLI can't read as the message it asked for.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Unread {
    /// Not an HTTP response at all: the connection carried something else, or broke.
    Garbled,
    /// A response that isn't a success, or whose body isn't the message.
    Refused { status: u16, body: String },
}

/// The message in `response`, its body read as `limits` read it.
///
/// # Errors
///
/// `Garbled` when `response` isn't an HTTP response, `Refused` when it isn't a success or its
/// body isn't a `T`.
pub fn decode<T: DeserializeOwned>(response: &[u8], limits: Limits) -> Result<T, Unread> {
    let (head, _) = split_head(response).ok_or(Unread::Garbled)?;
    let code = status(head).ok_or(Unread::Garbled)?;
    let content = body(response, limits).ok_or(Unread::Garbled)?;
    let refused = || Unread::Refused {
        status: code,
        body: String::from_utf8_lossy(&content).into_owned(),
    };
    if !(200..300).contains(&code) {
        return Err(refused());
    }
    bazhen_protocol::wire::from_slice(&content).map_err(|_| refused())
}

#[cfg(test)]
mod tests {
    use super::*;
    use bazhen_protocol::daemon::StopResponse;
    use bazhen_protocol::tasks::TaskCommandResponse;

    #[test]
    fn reads_a_message_sent_in_chunks() {
        let response = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n\
                         5\r\n{\"eve\r\nA\r\nntIds\":[]}\r\n0\r\n\r\n";
        assert_eq!(
            decode::<TaskCommandResponse>(response, LIMITS),
            Ok(TaskCommandResponse { event_ids: vec![] })
        );
    }

    #[test]
    fn reads_a_message_only_from_a_success_and_refuses_anything_else_with_its_status_and_body() {
        let ok = b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\n{\"eventIds\":[]}";
        let missing = b"HTTP/1.1 404 Not Found\r\nContent-Length: 13\r\n\r\n404 Not Found";
        let refusal = br#"{"error":"forbidden","message":"an agent can't stop the daemon"}"#;
        let mut forbidden = format!(
            "HTTP/1.1 403 Forbidden\r\nContent-Length: {}\r\n\r\n",
            refusal.len()
        )
        .into_bytes();
        forbidden.extend_from_slice(refusal);
        assert_eq!(
            [
                decode::<TaskCommandResponse>(ok, LIMITS).map(|_| ()),
                decode::<TaskCommandResponse>(missing, LIMITS).map(|_| ()),
                decode::<StopResponse>(&forbidden, LIMITS).map(|_| ()),
                decode::<StopResponse>(b"not http\r\n\r\n{}", LIMITS).map(|_| ()),
            ],
            [
                Ok(()),
                Err(Unread::Refused {
                    status: 404,
                    body: "404 Not Found".to_owned()
                }),
                Err(Unread::Refused {
                    status: 403,
                    body: String::from_utf8_lossy(refusal).into_owned()
                }),
                Err(Unread::Garbled),
            ]
        );
    }
}

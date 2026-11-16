//! The daemon's answer to a call, read as the message the call expects. Only the body counts:
//! an answer is the message it holds, whatever its status, and anything else is refused with the
//! status and the body as they came.

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
    /// A response whose body isn't the message.
    Refused { status: u16, body: String },
}

/// The message in `response`, its body read as `limits` read it.
///
/// # Errors
///
/// `Garbled` when `response` isn't an HTTP response, `Refused` when its body isn't a `T`.
pub fn decode<T: DeserializeOwned>(response: &[u8], limits: Limits) -> Result<T, Unread> {
    let (head, _) = split_head(response).ok_or(Unread::Garbled)?;
    let code = status(head).ok_or(Unread::Garbled)?;
    let content = body(response, limits).ok_or(Unread::Garbled)?;
    bazhen_protocol::wire::from_slice(&content).map_err(|_| Unread::Refused {
        status: code,
        body: String::from_utf8_lossy(&content).into_owned(),
    })
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
    fn reads_the_body_whatever_the_status_and_refuses_one_that_isnt_the_message() {
        let ok = b"HTTP/1.1 200 OK\r\nContent-Length: 15\r\n\r\n{\"eventIds\":[]}";
        let error = b"HTTP/1.1 404 Not Found\r\nContent-Length: 13\r\n\r\n404 Not Found";
        let stop = b"HTTP/1.1 403 Forbidden\r\nContent-Length: 2\r\n\r\n{}";
        assert_eq!(
            decode::<TaskCommandResponse>(ok, LIMITS),
            Ok(TaskCommandResponse { event_ids: vec![] })
        );
        assert_eq!(
            decode::<TaskCommandResponse>(error, LIMITS),
            Err(Unread::Refused {
                status: 404,
                body: "404 Not Found".to_owned()
            })
        );
        assert_eq!(decode::<StopResponse>(stop, LIMITS), Ok(StopResponse {}));
        assert_eq!(
            decode::<StopResponse>(b"not http\r\n\r\n{}", LIMITS),
            Err(Unread::Garbled)
        );
    }
}

//! Where a response the daemon sends ends, and what its head says, read from bytes that may be cut
//! short or be anything at all.

use std::io::{self, Read};
use std::os::unix::net::UnixStream;
use std::time::Duration;

/// The most head and body a reader takes from one response. Past either, the response ends at its
/// head, and a caller refuses it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub head: usize,
    pub body: usize,
}

/// Reads one response, up to where `Framing` says it ends, so it never waits on the daemon closing
/// the connection: a reader blocked on that close has been seen to miss it and hang with the whole
/// reply in hand. Once the reply has begun, each read gets `stall` at most, so one that stops short
/// of its end times out rather than hangs.
pub(crate) fn read_response(
    stream: &mut UnixStream,
    limits: Limits,
    stall: Duration,
) -> io::Result<Vec<u8>> {
    let cap = limits.head + 4 + limits.body + 1;
    let mut response = Vec::new();
    let mut chunk = vec![0; 64 << 10];
    let mut framing = Framing::new(limits);
    // end_of answers by cap - 1 bytes, and the chunk never reads past cap, so this ends.
    loop {
        if let Some(end) = framing.end_of(&response) {
            response.truncate(end);
            break;
        }
        chunk.truncate(cap - response.len());
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => {
                if response.is_empty() {
                    bound_reads(stream, stall)?;
                }
                response.extend_from_slice(chunk.get(..n).unwrap_or(&chunk));
            }
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(response)
}

fn bound_reads(stream: &UnixStream, stall: Duration) -> io::Result<()> {
    bound_or_unblock(stream, stream.set_read_timeout(Some(stall)))
}

/// macOS refuses a read timeout (EINVAL) on a connection the daemon has already closed. Its
/// bytes are all in by then, so the reads that remain need not wait at all: they turn
/// non-blocking rather than keep the deadline, which a reader waiting for that close can sit out.
fn bound_or_unblock(stream: &UnixStream, set: io::Result<()>) -> io::Result<()> {
    match set {
        Err(e) if e.kind() == io::ErrorKind::InvalidInput && e.raw_os_error().is_some() => {
            stream.set_nonblocking(true)
        }
        result => result,
    }
}

/// Where the response ends, once enough of it has arrived to say: at the end of the body its
/// `Content-Length` promises; or at the end of a head a reader refuses whatever follows it, one
/// without a usable length, over the head limit, or not UTF-8; or, with no end of head yet, as soon
/// as any head would be over the limit. A refused reply is never read on to the close: a close that
/// comes late, or as a reset, would make the reader take it for one cut short, which a waiter
/// retries.
pub fn reply_end(response: &[u8], limits: Limits) -> Option<usize> {
    Framing::new(limits).end_of(response)
}

/// `reply_end` for a response read a little at a time, which keeps what each call learns: how far
/// the end of head has been looked for, and, once the head is in, where the reply ends. A reply
/// that arrives a few bytes at a time is so never scanned again from its start.
#[derive(Debug)]
pub struct Framing {
    limits: Limits,
    searched: usize,
    end: Option<usize>,
}

impl Framing {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            searched: 0,
            end: None,
        }
    }

    /// `reply_end(response)`, where `response` extends every response this was given before.
    pub fn end_of(&mut self, response: &[u8]) -> Option<usize> {
        if self.end.is_none() {
            let from = self.searched;
            // The next end of head can begin in the last 3 bytes already searched.
            self.searched = response.len().saturating_sub(3);
            let found = response
                .get(from..)
                .and_then(|rest| rest.windows(4).position(|w| w == b"\r\n\r\n"));
            match found {
                Some(at) => self.end = Some(end_by_head(response, from + at, self.limits)),
                None => {
                    return (response.len() >= self.limits.head + 4).then_some(response.len());
                }
            }
        }
        self.end.filter(|&end| response.len() >= end)
    }
}

/// Where a response whose head ends at `head_end` ends: after the body its `Content-Length`
/// promises, or straight after a head a reader refuses.
fn end_by_head(response: &[u8], head_end: usize, limits: Limits) -> usize {
    let head_len = head_end + 4;
    let length = response
        .get(..head_end)
        .and_then(|head| std::str::from_utf8(head).ok())
        .and_then(content_length)
        .filter(|&n| head_end <= limits.head && n <= limits.body);
    length.map_or(head_len, |n| head_len + n)
}

/// Whether the response ended early, before `reply_end` could say where it ends. Anything else is
/// refused by its reader rather than retried.
pub fn is_truncated(response: &[u8], limits: Limits) -> bool {
    reply_end(response, limits).is_none()
}

/// A response's head, as text, and its body.
pub fn split_head(response: &[u8]) -> Option<(&str, &[u8])> {
    let end = response.windows(4).position(|w| w == b"\r\n\r\n")?;
    let (head, rest) = response.split_at_checked(end)?;
    Some((std::str::from_utf8(head).ok()?, rest.get(4..)?))
}

/// The values of every header `name` names, ignoring case, in the order they came.
pub fn headers<'a>(head: &'a str, name: &str) -> impl Iterator<Item = &'a str> {
    head.split("\r\n").skip(1).filter_map(move |line| {
        let (key, value) = line.split_once(':')?;
        key.trim().eq_ignore_ascii_case(name).then(|| value.trim())
    })
}

/// The header's value when it appears exactly once; a repeated header is as bad as a missing one.
pub fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    let mut values = headers(head, name);
    let value = values.next()?;
    values.next().is_none().then_some(value)
}

/// The length in a single `Content-Length` of ASCII digits alone: `usize`'s parser would also
/// take a sign.
pub fn content_length(head: &str) -> Option<usize> {
    let value = header(head, "Content-Length")?;
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

/// The status code on a head's first line, `HTTP/1.1 200 OK`.
pub fn status(head: &str) -> Option<u16> {
    let line = head.split("\r\n").next()?;
    let mut parts = line.split(' ');
    let version = parts.next()?;
    let code = parts.next()?;
    let digits = code.len() == 3 && code.bytes().all(|b| b.is_ascii_digit());
    (version.starts_with("HTTP/1.") && digits)
        .then(|| code.parse().ok())
        .flatten()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::Instant;

    const LIMITS: Limits = Limits {
        head: 16 << 10,
        body: 1 << 20,
    };

    fn response(headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut out = b"HTTP/1.1 200 OK\r\n".to_vec();
        for (k, v) in headers {
            out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(body);
        out
    }

    fn ok() -> Vec<u8> {
        response(&[("Content-Type", "x"), ("Content-Length", "2")], b"hi")
    }

    fn edit(response: &[u8], from: &str, to: &str) -> Vec<u8> {
        String::from_utf8(response.to_vec())
            .unwrap()
            .replace(from, to)
            .into_bytes()
    }

    const STALL: Duration = Duration::from_millis(200);

    /// The client's end of a connection on which the daemon has written `data` and, unless
    /// `close`, kept the connection open; the daemon's end is returned to hold it so.
    fn daemon_wrote(data: &[u8], close: bool) -> (UnixStream, Option<UnixStream>) {
        let (client, mut daemon) = UnixStream::pair().unwrap();
        daemon.write_all(data).unwrap();
        // A read that waits for a close that never comes fails the test instead of hanging it.
        client
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        (client, (!close).then_some(daemon))
    }

    #[test]
    fn reads_a_reply_to_its_length_without_waiting_for_the_close() {
        let (mut client, _open) = daemon_wrote(&ok(), false);
        assert_eq!(read_response(&mut client, LIMITS, STALL).unwrap(), ok());
    }

    #[test]
    fn ignores_what_follows_the_promised_body() {
        let (mut client, _open) = daemon_wrote(&[&ok()[..], b"junk"].concat(), false);
        assert_eq!(read_response(&mut client, LIMITS, STALL).unwrap(), ok());
    }

    #[test]
    fn stops_at_the_head_of_a_reply_without_a_length_on_a_connection_held_open() {
        let unframed = edit(&ok(), "Content-Length: 2\r\n", "");
        let head = unframed[..unframed.len() - 2].to_vec();
        let (mut client, _open) = daemon_wrote(&unframed, false);
        let read = read_response(&mut client, LIMITS, STALL).map_err(|e| e.kind());
        assert_eq!(read, Ok(head));
    }

    #[test]
    fn gives_up_on_a_reply_that_stops_short_of_its_length() {
        let ok = ok();
        let (mut client, _open) = daemon_wrote(&ok[..ok.len() - 1], false);
        let start = Instant::now();
        assert!(read_response(&mut client, LIMITS, STALL).is_err());
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "{:?}",
            start.elapsed()
        );
    }

    #[test]
    fn reads_without_waiting_once_the_closed_connection_refuses_a_timeout() {
        let unframed = edit(&ok(), "Content-Length: 2\r\n", "");
        // Held open, so a read that still blocked would wait out the 2 s timeout.
        let (client, _open) = daemon_wrote(&unframed, false);
        let einval = Err(io::Error::from_raw_os_error(22));
        bound_or_unblock(&client, einval).unwrap();
        let start = Instant::now();
        let mut response = Vec::new();
        let rest = (&client).read_to_end(&mut response);
        assert_eq!(response, unframed);
        assert_eq!(rest.map_err(|e| e.kind()), Err(io::ErrorKind::WouldBlock));
        assert!(start.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn only_a_response_that_ended_early_is_truncated() {
        let ok = ok();
        assert!(!is_truncated(&ok, LIMITS));
        assert!(is_truncated(&ok[..ok.len() - 1], LIMITS));
        assert!(is_truncated(
            b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n",
            LIMITS
        ));
        assert!(is_truncated(b"", LIMITS));
        // One more byte would end a head of exactly the limit.
        assert!(is_truncated(
            &[&vec![b'x'; LIMITS.head][..], b"\r\n\r"].concat(),
            LIMITS
        ));
        // Refused, not retried: no length, a head that isn't text, or more head or body than a
        // reply may have.
        assert!(!is_truncated(
            &edit(&ok, "Content-Length: 2\r\n", ""),
            LIMITS
        ));
        assert!(!is_truncated(b"HTTP/1.1 200 OK\r\nX: \xff\r\n\r\n", LIMITS));
        assert!(!is_truncated(&vec![b'x'; LIMITS.head + 4], LIMITS));
        let huge = (LIMITS.body + 1).to_string();
        assert!(!is_truncated(
            &edit(&ok, "Content-Length: 2", &format!("Content-Length: {huge}")),
            LIMITS
        ));
    }

    #[test]
    fn a_reply_too_long_to_accept_ends_at_its_head() {
        let ok = ok();
        let over = (LIMITS.body + 1).to_string();
        let huge = edit(&ok, "Content-Length: 2", &format!("Content-Length: {over}"));
        let padding = format!("X-Pad: {}\r\nContent-Type", "x".repeat(LIMITS.head));
        let long_head = edit(&ok, "Content-Type", &padding);
        for refused in [huge, long_head] {
            assert_eq!(reply_end(&refused, LIMITS), Some(refused.len() - 2));
        }
    }

    #[test]
    fn a_larger_body_limit_reads_a_body_a_smaller_one_refuses() {
        let body = vec![b'x'; LIMITS.body + 1];
        let length = body.len().to_string();
        let big = response(&[("Content-Length", &length)], &body);
        let wider = Limits {
            body: LIMITS.body * 2,
            ..LIMITS
        };
        assert_eq!(reply_end(&big, wider), Some(big.len()));
        assert_eq!(reply_end(&big, LIMITS), Some(big.len() - body.len()));
    }

    #[test]
    fn reads_a_header_once_and_a_length_of_digits_alone() {
        let twice = "HTTP/1.1 200 OK\r\nA: 1\r\na: 2";
        assert_eq!(header(twice, "A"), None);
        assert_eq!(headers(twice, "a").collect::<Vec<_>>(), ["1", "2"]);
        for (value, length) in [("2", Some(2)), ("+2", None), ("", None), ("2 2", None)] {
            let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {value}");
            assert_eq!(content_length(&head), length, "{value:?}");
        }
    }

    #[test]
    fn reads_the_status_of_a_head_and_nothing_else() {
        let cases = [
            ("HTTP/1.1 404 Not Found\r\nX: y", Some(404)),
            ("HTTP/1.0 200 OK", Some(200)),
            ("HTTP/1.1 20 OK", None),
            ("HTTP/1.1 +20 OK", None),
            ("HTTP/2 200", None),
            ("", None),
        ];
        for (head, code) in cases {
            assert_eq!(status(head), code, "{head:?}");
        }
    }
}

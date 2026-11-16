//! Where a response the daemon sends ends, and what its head says, read from bytes that may be cut
//! short or be anything at all.

use std::io::{self, Read};
use std::os::unix::net::UnixStream;
use std::time::{Duration, Instant};

/// The most head and body a reader takes from one response. Past either, the response ends at its
/// head, and a caller refuses it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Limits {
    pub head: usize,
    pub body: usize,
    /// Whether a body sent in chunks (`Transfer-Encoding: chunked`) is read, as an HTTP client
    /// reads one; without it, a response with no length ends at its head and is refused.
    pub chunked: bool,
}

/// Reads one response, up to where `Framing` says it ends, so it never waits on the daemon closing
/// the connection: a reader blocked on that close has been seen to miss it and hang with the whole
/// reply in hand. No read waits past `deadline`, and once the reply has begun, none waits more than
/// `stall` either, so one that stops short of its end times out rather than hangs, and one that
/// dribbles in can't outlast the deadline.
pub(crate) fn read_response(
    stream: &mut UnixStream,
    limits: Limits,
    stall: Duration,
    deadline: Instant,
) -> io::Result<Vec<u8>> {
    let cap = read_cap(limits);
    let mut response = Vec::new();
    let mut chunk = vec![0; 64 << 10];
    let mut framing = Framing::new(limits);
    // end_of answers by cap - 1 bytes, and the chunk never reads past cap, so this ends.
    loop {
        if let Some(end) = framing.end_of(&response) {
            response.truncate(end);
            break;
        }
        let left = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())
            .ok_or(io::Error::from(io::ErrorKind::TimedOut))?;
        let wait = if response.is_empty() {
            left
        } else {
            left.min(stall)
        };
        bound_reads(stream, wait)?;
        chunk.truncate(cap - response.len());
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => response.extend_from_slice(chunk.get(..n).unwrap_or(&chunk)),
            Err(e) if e.kind() == io::ErrorKind::Interrupted => {}
            Err(e) => return Err(e),
        }
    }
    Ok(response)
}

/// The most of a response read: a head and a body at their limits, and for a body sent in chunks,
/// the most `ChunkScan` takes before it answers.
fn read_cap(limits: Limits) -> usize {
    let body = if limits.chunked {
        chunks_bound(limits.body)
    } else {
        limits.body
    };
    limits.head.saturating_add(body).saturating_add(5)
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
    /// How far a body sent in chunks has been read, once a head saying so is in.
    chunks: Option<ChunkScan>,
}

impl Framing {
    pub fn new(limits: Limits) -> Self {
        Self {
            limits,
            searched: 0,
            end: None,
            chunks: None,
        }
    }

    /// `reply_end(response)`, where `response` extends every response this was given before.
    pub fn end_of(&mut self, response: &[u8]) -> Option<usize> {
        if let Some(scan) = &mut self.chunks {
            return scan.end(response, self.limits.body);
        }
        if self.end.is_none() {
            let from = self.searched;
            // The next end of head can begin in the last 3 bytes already searched.
            self.searched = response.len().saturating_sub(3);
            let found = response
                .get(from..)
                .and_then(|rest| rest.windows(4).position(|w| w == b"\r\n\r\n"));
            let Some(at) = found else {
                let over = self.limits.head.saturating_add(4);
                return (response.len() >= over).then_some(response.len());
            };
            let head_end = from + at;
            if self.limits.chunked && head_end <= self.limits.head && in_chunks(response, head_end)
            {
                let mut scan = ChunkScan::new(head_end + 4);
                let end = scan.end(response, self.limits.body);
                self.chunks = Some(scan);
                return end;
            }
            self.end = Some(end_by_head(response, head_end, self.limits));
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
    length.map_or(head_len, |n| head_len.saturating_add(n))
}

/// Whether the head ending at `head_end` sends its body in chunks, and gives it no length.
fn in_chunks(response: &[u8], head_end: usize) -> bool {
    let Some(head) = response
        .get(..head_end)
        .and_then(|h| std::str::from_utf8(h).ok())
    else {
        return false;
    };
    let chunked =
        header(head, "Transfer-Encoding").is_some_and(|v| v.eq_ignore_ascii_case("chunked"));
    chunked && headers(head, "Content-Length").next().is_none()
}

/// The longest line a chunk's size, its extensions or a trailer may take.
const CHUNK_LINE_MAX: usize = 4096;

/// The most a body sent in chunks may take, its framing included, for `limit` bytes of data.
fn chunks_bound(limit: usize) -> usize {
    limit.saturating_mul(2).saturating_add(CHUNK_LINE_MAX)
}

/// How a body sent in chunks stands.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Chunks {
    /// It ends here; the bytes before are the response.
    Done(usize),
    /// More is to come.
    More,
    /// It isn't chunks, or holds more data or framing than the limit allows.
    Bad,
}

/// A body sent in chunks, read as far as it has come: it picks up where it stopped, so a body read
/// a few bytes at a time is never scanned again from its start.
#[derive(Debug, Clone, Copy)]
struct ChunkScan {
    start: usize,
    /// Where the next size line, or trailer line, begins.
    at: usize,
    /// The data its chunks have held so far.
    data: usize,
    trailers: bool,
}

impl ChunkScan {
    fn new(start: usize) -> Self {
        Self {
            start,
            at: start,
            data: 0,
            trailers: false,
        }
    }

    /// Where the response ends, if it has; `limit` bounds the data, and the framing around it too.
    /// Once the chunks have taken `chunks_bound` and still don't end, they are refused, so this
    /// answers before a read reaches `read_cap`.
    fn end(&mut self, response: &[u8], limit: usize) -> Option<usize> {
        match self.advance(response, limit, |_| {}) {
            Chunks::Done(end) => Some(end),
            Chunks::More if response.len() - self.start < chunks_bound(limit) => None,
            Chunks::More | Chunks::Bad => Some(response.len()),
        }
    }

    /// Reads on from where it stopped, handing each chunk's data to `data` as it goes. A line is
    /// judged by its length whole, never by how much of it has come, so how the reads split it
    /// changes nothing.
    fn advance(&mut self, response: &[u8], limit: usize, mut data: impl FnMut(&[u8])) -> Chunks {
        loop {
            if self.at - self.start > chunks_bound(limit) {
                return Chunks::Bad;
            }
            let rest = response.get(self.at..).unwrap_or_default();
            let Some(line_len) = rest.windows(2).position(|w| w == b"\r\n") else {
                return if rest.len() > CHUNK_LINE_MAX + 1 {
                    Chunks::Bad
                } else {
                    Chunks::More
                };
            };
            if line_len > CHUNK_LINE_MAX {
                return Chunks::Bad;
            }
            let line_end = self.at + line_len;
            if self.trailers {
                if line_len == 0 {
                    return Chunks::Done(line_end + 2);
                }
                self.at = line_end + 2;
                continue;
            }
            let size = rest
                .get(..line_len)
                .and_then(|line| std::str::from_utf8(line).ok())
                .and_then(|line| line.split(';').next())
                .map(str::trim)
                .filter(|hex| {
                    !hex.is_empty() && hex.len() <= 16 && hex.bytes().all(|b| b.is_ascii_hexdigit())
                })
                .and_then(|hex| usize::from_str_radix(hex, 16).ok());
            let Some(size) = size else {
                return Chunks::Bad;
            };
            if size == 0 {
                self.trailers = true;
                self.at = line_end + 2;
                continue;
            }
            if self.data.saturating_add(size) > limit {
                return Chunks::Bad;
            }
            let data_at = line_end + 2;
            let data_end = data_at.saturating_add(size);
            match response.get(data_end..data_end.saturating_add(2)) {
                None => return Chunks::More,
                Some(b"\r\n") => {}
                Some(_) => return Chunks::Bad,
            }
            data(response.get(data_at..data_end).unwrap_or_default());
            self.data += size;
            self.at = data_end + 2;
        }
    }
}

/// A whole response's body: the bytes after its head, or the data of its chunks joined, when
/// `limits` read chunks and the head says it sends them. None when it isn't a response, or its
/// chunks are malformed or cut short.
pub fn body(response: &[u8], limits: Limits) -> Option<Vec<u8>> {
    let head_end = response.windows(4).position(|w| w == b"\r\n\r\n")?;
    let rest = response.get(head_end + 4..)?;
    if !(limits.chunked && in_chunks(response, head_end)) {
        return Some(rest.to_vec());
    }
    let mut out = Vec::new();
    let mut scan = ChunkScan::new(head_end + 4);
    match scan.advance(response, limits.body, |d| out.extend_from_slice(d)) {
        Chunks::Done(_) => Some(out),
        Chunks::More | Chunks::Bad => None,
    }
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
        chunked: false,
    };
    const CHUNKED: Limits = Limits {
        chunked: true,
        ..LIMITS
    };

    fn chunked(body: &[u8]) -> Vec<u8> {
        [
            b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n",
            body,
        ]
        .concat()
    }

    #[test]
    fn reads_a_body_sent_in_chunks_to_its_last_chunk_and_joins_them() {
        let whole = chunked(b"4\r\n{\"a\"\r\n3;x=y\r\n:1}\r\n0\r\nT: v\r\n\r\n");
        let (mut client, _open) = daemon_wrote(&[&whole[..], b"junk"].concat(), false);
        assert_eq!(reply_end(&whole, CHUNKED), Some(whole.len()));
        assert_eq!(
            read_response(&mut client, CHUNKED, STALL, soon()).unwrap(),
            whole
        );
        assert_eq!(body(&whole, CHUNKED), Some(b"{\"a\":1}".to_vec()));
        assert_eq!(reply_end(&whole[..whole.len() - 1], CHUNKED), None);
    }

    #[test]
    fn ends_at_once_on_chunks_it_refuses_and_reads_none_without_the_limit() {
        let bad = chunked(b"zz\r\nabc\r\n");
        let over = chunked(b"8\r\n12345678\r\n0\r\n\r\n");
        let small = Limits { body: 4, ..CHUNKED };
        assert_eq!(reply_end(&bad, CHUNKED), Some(bad.len()));
        assert_eq!(body(&bad, CHUNKED), None);
        assert_eq!(reply_end(&over, small), Some(over.len()));
        assert_eq!(body(&over, small), None);
        let whole = chunked(b"2\r\nhi\r\n0\r\n\r\n");
        let head_only = whole.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        assert_eq!(reply_end(&whole, LIMITS), Some(head_only));
    }

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

    fn soon() -> Instant {
        Instant::now() + Duration::from_secs(2)
    }

    #[test]
    fn gives_up_at_its_deadline_on_a_reply_that_dribbles_in() {
        let (mut client, mut daemon) = UnixStream::pair().unwrap();
        let writer = std::thread::spawn(move || {
            for _ in 0..40 {
                if daemon.write_all(b"H").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        });
        let start = Instant::now();
        let deadline = start + Duration::from_millis(500);
        let read = read_response(&mut client, LIMITS, STALL, deadline).map_err(|e| e.kind());
        // A read that times out says WouldBlock on Linux; one the deadline stops first, TimedOut.
        assert!(
            matches!(
                read,
                Err(io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock)
            ),
            "{read:?}"
        );
        // The writer goes on for 2 s: a read held only by the stall would last all of it.
        assert!(
            start.elapsed() < Duration::from_millis(1500),
            "{:?}",
            start.elapsed()
        );
        drop(client);
        writer.join().unwrap();
    }

    #[test]
    fn refuses_chunks_that_go_on_past_the_read_cap_rather_than_call_them_cut_short() {
        let small = Limits {
            head: 1024,
            body: 16,
            chunked: true,
        };
        let (mut client, mut daemon) = UnixStream::pair().unwrap();
        let line = format!("1;{}\r\na\r\n", "x".repeat(4000));
        let mut sent = b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n".to_vec();
        for _ in 0..3 {
            sent.extend_from_slice(line.as_bytes());
        }
        assert!(sent.len() > read_cap(small));
        // More than macOS's socket buffer holds, so it is written beside the read, and the
        // daemon then holds the connection open, as one still sending would.
        let (done, finished) = std::sync::mpsc::channel::<()>();
        let writer = std::thread::spawn(move || {
            // The client stops reading at its cap, and its drop ends a write still waiting.
            let _ = daemon.write_all(&sent);
            let _ = finished.recv();
        });
        let read = read_response(&mut client, small, STALL, soon()).unwrap();
        assert!(read.len() <= read_cap(small), "{}", read.len());
        assert!(!is_truncated(&read, small));
        assert_eq!(body(&read, small), None);
        drop(client);
        drop(done);
        writer.join().unwrap();
    }

    #[test]
    fn judges_a_chunk_line_whole_however_the_reads_split_it() {
        let line = format!("2;{}\r\nhi\r\n0\r\n\r\n", "x".repeat(200));
        let whole = chunked(line.as_bytes());
        let head = whole.windows(4).position(|w| w == b"\r\n\r\n").unwrap() + 4;
        let mut framing = Framing::new(CHUNKED);
        let mut ends = Vec::new();
        for k in head..=whole.len() {
            ends.push(framing.end_of(&whole[..k]));
        }
        assert_eq!(ends.iter().flatten().collect::<Vec<_>>(), [&whole.len()]);
        assert_eq!(body(&whole, CHUNKED), Some(b"hi".to_vec()));
    }

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
        assert_eq!(
            read_response(&mut client, LIMITS, STALL, soon()).unwrap(),
            ok()
        );
    }

    #[test]
    fn ignores_what_follows_the_promised_body() {
        let (mut client, _open) = daemon_wrote(&[&ok()[..], b"junk"].concat(), false);
        assert_eq!(
            read_response(&mut client, LIMITS, STALL, soon()).unwrap(),
            ok()
        );
    }

    #[test]
    fn stops_at_the_head_of_a_reply_without_a_length_on_a_connection_held_open() {
        let unframed = edit(&ok(), "Content-Length: 2\r\n", "");
        let head = unframed[..unframed.len() - 2].to_vec();
        let (mut client, _open) = daemon_wrote(&unframed, false);
        let read = read_response(&mut client, LIMITS, STALL, soon()).map_err(|e| e.kind());
        assert_eq!(read, Ok(head));
    }

    #[test]
    fn gives_up_on_a_reply_that_stops_short_of_its_length() {
        let ok = ok();
        let (mut client, _open) = daemon_wrote(&ok[..ok.len() - 1], false);
        let start = Instant::now();
        assert!(read_response(&mut client, LIMITS, STALL, soon()).is_err());
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
    fn limits_as_large_as_a_usize_holds_frame_as_any_other() {
        let most = Limits {
            head: usize::MAX,
            body: usize::MAX,
            chunked: true,
        };
        let (mut client, _open) = daemon_wrote(&ok(), false);
        assert_eq!(reply_end(&ok(), most), Some(ok().len()));
        assert!(!is_truncated(&ok(), most));
        assert_eq!(
            read_response(&mut client, most, STALL, soon()).unwrap(),
            ok()
        );
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

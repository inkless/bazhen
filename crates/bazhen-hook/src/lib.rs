//! `bazhen-hook <event>`: the hook client a harness runs for each of Bazhen's hooks. It forwards
//! the hook's input over the daemon's Unix socket and prints the reply verbatim, knowing no
//! harness format. Outside a Bazhen agent, or on any failure, it exits 0 with no output, so the
//! harness carries on as it would without Bazhen.
//!
//! The reply's framing is documented beside `HookReply` in packages/protocol/src/mail.ts. Its
//! decoders are public so the fuzz targets in `fuzz/` can reach them.

pub mod pane_ready;
pub mod pane_title;
pub mod shell_report;
mod statusline;

use std::env;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::parent_id;
use std::process::id;
use std::thread::sleep;
use std::time::{Duration, Instant};

const PROTOCOL_VERSION: &str = "1.0";
const REPLY_TYPE: &str = "application/vnd.bazhen.hook-reply";
const MAX_BODY: usize = 1 << 20;
const MAX_HEAD: usize = 16 << 10;
/// Only a backstop: the harness's own timeout for each hook ends it first.
const HOOK_DEADLINE: Duration = Duration::from_mins(10);
/// The waiter outlives a daemon restart by reconnecting, and gives up before its hook's timeout.
const WAIT_DEADLINE: Duration = Duration::from_hours(23);
const ACK_DEADLINE: Duration = Duration::from_secs(5);
/// `PostToolUse` runs on every tool call, and a fold it misses waits for a wake, so a slow daemon
/// costs a tool call at most this; with the ack after it, well inside the hook's 10 s timeout.
const FOLD_DEADLINE: Duration = Duration::from_secs(2);
/// How long the rest of a reply may take once its first byte is in: the waiter may wait hours
/// for a reply to begin, but a daemon that stops partway through one has failed.
const REPLY_STALL: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq)]
pub struct Reply {
    exit_code: i32,
    offered: Vec<String>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

/// Runs the command the arguments name, and returns the status the process exits with.
pub fn exit_code() -> i32 {
    let ran = match env::args().nth(1).as_deref() {
        Some("pane-title") => pane_title::run(env::args().skip(2)),
        Some("shell-report") => shell_report::run(env::args().skip(2)),
        Some("shell-prompt") => shell_report::run_prompt(env::args().skip(2)),
        Some("pane-ready") => Some(pane_ready::run(env::args().skip(2))),
        Some("statusline-wrap") => statusline::run(env::args().skip(2)),
        _ => run(),
    };
    ran.unwrap_or(0)
}

fn run() -> Option<i32> {
    let agent = env::var("BAZHEN_AGENT_ID").ok()?;
    let socket = env::var("BAZHEN_SOCKET").ok()?;
    let event = env::args().nth(1)?;
    if !is_token(&agent) || !is_token(&event) {
        return None;
    }
    let token = agent_token();
    let mut payload = Vec::new();
    io::stdin().read_to_end(&mut payload).ok()?;
    let request = hook_request(&payload, &agent, &event, id(), parent_id());
    let deadline = match event.as_str() {
        "wait" => WAIT_DEADLINE,
        "PostToolUse" => FOLD_DEADLINE,
        _ => HOOK_DEADLINE,
    };
    let reply = ask(
        &socket,
        &request,
        token.as_deref(),
        event == "wait",
        deadline,
    )?;
    io::stdout().write_all(&reply.stdout).ok()?;
    io::stdout().flush().ok()?;
    io::stderr().write_all(&reply.stderr).ok()?;
    if !reply.offered.is_empty() {
        // The reply is already out; an ack that fails leaves the mail offered, and the daemon
        // offers it again.
        let _ = post_as(
            &socket,
            "/v1/hooks/ack",
            &hook_ack(&agent, &reply.offered),
            ACK_DEADLINE,
            token.as_deref(),
        );
    }
    Some(reply.exit_code)
}

/// The agent token in the file `BAZHEN_AGENT_AUTH_FILE` names, if it holds one. The daemon
/// refuses an agent that names itself without the token it was given, so one that can't be read
/// is sent as nothing.
pub(crate) fn agent_token() -> Option<String> {
    let file = env::var_os("BAZHEN_AGENT_AUTH_FILE")?;
    let token = std::fs::read_to_string(file).ok()?;
    let token = token.trim();
    is_agent_token(token).then(|| token.to_owned())
}

/// A token as the daemon mints it: 32 bytes, base64url, so 43 characters that need no escaping
/// in a header.
pub fn is_agent_token(s: &str) -> bool {
    s.len() == 43
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// IDs and event names are plain tokens, so they go into JSON without escaping.
fn is_token(s: &str) -> bool {
    !s.is_empty()
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// The `HookRequest` JSON. The payload comes first, so the fixed keys after it win if the payload
/// tries to smuggle in its own; a payload that isn't JSON makes the daemon answer quietly.
fn hook_request(payload: &[u8], agent: &str, event: &str, pid: u32, parent_pid: u32) -> Vec<u8> {
    let payload: &[u8] = if payload.trim_ascii().is_empty() {
        b"null"
    } else {
        payload
    };
    let mut out = b"{\"payload\":".to_vec();
    out.extend_from_slice(payload);
    out.extend_from_slice(
        format!(
            ",\"protocolVersion\":\"{PROTOCOL_VERSION}\",\"agentId\":\"{agent}\",\
             \"event\":\"{event}\",\"pid\":{pid},\"ppid\":{parent_pid}}}"
        )
        .as_bytes(),
    );
    out
}

fn hook_ack(agent: &str, offered: &[String]) -> Vec<u8> {
    let ids = offered.join("\",\"");
    format!("{{\"agentId\":\"{agent}\",\"offered\":[\"{ids}\"]}}").into_bytes()
}

/// A waiter retries until its deadline when the daemon can't be reached or drops the request,
/// as it does across a restart; any other hook gives up at once.
fn ask(
    socket: &str,
    request: &[u8],
    token: Option<&str>,
    waiting: bool,
    within: Duration,
) -> Option<Reply> {
    let deadline = Instant::now() + within;
    loop {
        let left = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())?;
        match post_as(socket, "/v1/hooks", request, left, token) {
            Ok(response) => return parse_reply(&response),
            Err(_) if waiting => sleep(Duration::from_secs(1)),
            Err(_) => return None,
        }
    }
}

/// One HTTP/1.1 exchange; the whole response, or an error if it ended early.
fn post(socket: &str, path: &str, body: &[u8], timeout: Duration) -> io::Result<Vec<u8>> {
    post_as(socket, path, body, timeout, None)
}

/// As `post`, proving the agent the request comes from with its token.
pub(crate) fn post_as(
    socket: &str,
    path: &str,
    body: &[u8],
    timeout: Duration,
    token: Option<&str>,
) -> io::Result<Vec<u8>> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    stream.write_all(request_head(path, body.len(), token).as_bytes())?;
    stream.write_all(body)?;
    let response = read_response(&mut stream, REPLY_STALL.min(timeout))?;
    if is_truncated(&response) {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    Ok(response)
}

/// A request's head, with the agent's token when there is one, and only one that is a token.
fn request_head(path: &str, length: usize, token: Option<&str>) -> String {
    let token = token
        .filter(|t| is_agent_token(t))
        .map_or_default(|t| format!("Bazhen-Agent-Token: {t}\r\n"));
    format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
         {token}Content-Length: {length}\r\nConnection: close\r\n\r\n"
    )
}

/// Reads one response, up to where `reply_end` says it ends, so it never waits on the daemon
/// closing the connection: a reader blocked on that close has been seen to miss it and hang with
/// the whole reply in hand. Once the reply has begun, each read gets `stall` at most, so one that
/// stops short of its end times out rather than hangs.
fn read_response(stream: &mut UnixStream, stall: Duration) -> io::Result<Vec<u8>> {
    const LIMIT: usize = MAX_HEAD + 4 + MAX_BODY + 1;
    let mut response = Vec::new();
    let mut chunk = vec![0; 64 << 10];
    let mut framing = Framing::default();
    // reply_end answers by LIMIT - 1 bytes, and the chunk never reads past LIMIT, so this ends.
    loop {
        if let Some(end) = framing.end_of(&response) {
            response.truncate(end);
            break;
        }
        chunk.truncate(LIMIT - response.len());
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
/// `Content-Length` promises; or at the end of a head that `parse_reply` will refuse whatever
/// follows it, one without a usable length, over `MAX_HEAD`, or not UTF-8; or, with no end of head
/// yet, as soon as any head would be over `MAX_HEAD`. A refused reply is never read on to the close:
/// a close that comes late, or as a reset, would make the reader take it for one cut short, which
/// the waiter retries.
pub fn reply_end(response: &[u8]) -> Option<usize> {
    Framing::default().end_of(response)
}

/// `reply_end` for a response read a little at a time, which keeps what each call learns: how far
/// the end of head has been looked for, and, once the head is in, where the reply ends. A reply
/// that arrives a few bytes at a time is so never scanned again from its start.
#[derive(Debug, Default)]
pub struct Framing {
    searched: usize,
    end: Option<usize>,
}

impl Framing {
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
                Some(at) => self.end = Some(end_by_head(response, from + at)),
                None => return (response.len() >= MAX_HEAD + 4).then_some(response.len()),
            }
        }
        self.end.filter(|&end| response.len() >= end)
    }
}

/// Where a response whose head ends at `head_end` ends: after the body its `Content-Length`
/// promises, or straight after a head `parse_reply` will refuse.
fn end_by_head(response: &[u8], head_end: usize) -> usize {
    let head_len = head_end + 4;
    let length = response
        .get(..head_end)
        .and_then(|head| std::str::from_utf8(head).ok())
        .and_then(content_length)
        .filter(|&n| head_end <= MAX_HEAD && n <= MAX_BODY);
    length.map_or(head_len, |n| head_len + n)
}

/// Whether the response ended early, before `reply_end` could say where it ends. Anything else is
/// refused by `parse_reply` rather than retried.
pub fn is_truncated(response: &[u8]) -> bool {
    reply_end(response).is_none()
}

fn split_head(response: &[u8]) -> Option<(&str, &[u8])> {
    let end = response.windows(4).position(|w| w == b"\r\n\r\n")?;
    let (head, rest) = response.split_at_checked(end)?;
    Some((std::str::from_utf8(head).ok()?, rest.get(4..)?))
}

fn headers<'a>(head: &'a str, name: &str) -> impl Iterator<Item = &'a str> {
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

/// The daemon's framed reply, or None for anything else: the hook then fails open.
pub fn parse_reply(response: &[u8]) -> Option<Reply> {
    let (head, body) = split_head(response)?;
    let status = head.split("\r\n").next()?;
    let length = content_length(head)?;
    let stdout_bytes: usize = header(head, "Bazhen-Stdout-Bytes")?.parse().ok()?;
    let offered = header(head, "Bazhen-Offered")?;
    let offered: Vec<String> = match offered {
        "" => Vec::new(),
        list => list.split(',').map(str::to_owned).collect(),
    };
    let well_formed = head.len() <= MAX_HEAD
        && status.split(' ').nth(1) == Some("200")
        && header(head, "Content-Type") == Some(REPLY_TYPE)
        && headers(head, "Transfer-Encoding").next().is_none()
        && length <= MAX_BODY
        && body.len() == length
        && offered.iter().all(|id| is_token(id));
    if !well_formed {
        return None;
    }
    let (stdout, stderr) = body.split_at_checked(stdout_bytes)?;
    Some(Reply {
        exit_code: header(head, "Bazhen-Exit-Code")?.parse::<u8>().ok()?.into(),
        offered,
        stdout: stdout.to_vec(),
        stderr: stderr.to_vec(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn response(headers: &[(&str, &str)], body: &[u8]) -> Vec<u8> {
        let mut out = b"HTTP/1.1 200 OK\r\n".to_vec();
        for (k, v) in headers {
            out.extend_from_slice(format!("{k}: {v}\r\n").as_bytes());
        }
        out.extend_from_slice(b"\r\n");
        out.extend_from_slice(body);
        out
    }

    fn edit(response: &[u8], from: &str, to: &str) -> Vec<u8> {
        String::from_utf8(response.to_vec())
            .unwrap()
            .replace(from, to)
            .into_bytes()
    }

    fn framed(exit: &str, offered: &str, stdout: &str, body: &[u8]) -> Vec<u8> {
        let length = body.len().to_string();
        response(
            &[
                ("Content-Type", REPLY_TYPE),
                ("Content-Length", &length),
                ("Bazhen-Exit-Code", exit),
                ("Bazhen-Offered", offered),
                ("Bazhen-Stdout-Bytes", stdout),
            ],
            body,
        )
    }

    #[test]
    fn head_carries_the_agent_token_only_when_it_is_one() {
        let token = "t".repeat(43);
        let with = request_head("/v1/hooks", 2, Some(&token));
        let forged = request_head("/v1/hooks", 2, Some("x\r\nBazhen-Agent-Id: agent_y"));
        let without = request_head("/v1/hooks", 2, None);
        assert!(with.contains(&format!("\r\nBazhen-Agent-Token: {token}\r\n")));
        assert_eq!(forged, without);
        assert!(!without.contains("Bazhen-Agent-Token"));
    }

    #[test]
    fn request_puts_the_payload_first_so_fixed_keys_win() {
        let request = hook_request(b"{\"a\":1}", "agent_x", "Stop", 7, 3);
        assert_eq!(
            String::from_utf8(request).unwrap(),
            "{\"payload\":{\"a\":1},\"protocolVersion\":\"1.0\",\"agentId\":\"agent_x\",\
             \"event\":\"Stop\",\"pid\":7,\"ppid\":3}"
        );
    }

    #[test]
    fn request_sends_null_for_empty_stdin() {
        let request = String::from_utf8(hook_request(b" \n", "agent_x", "Stop", 1, 1)).unwrap();
        assert!(request.starts_with("{\"payload\":null,"));
    }

    #[test]
    fn tokens_reject_anything_that_would_need_escaping() {
        assert!(is_token("agent_01J-x"));
        for bad in ["", "a\"b", "a b", "a\\b", "é"] {
            assert!(!is_token(bad), "{bad:?}");
        }
    }

    #[test]
    fn splits_stdout_from_stderr_by_byte_count() {
        let reply = parse_reply(&framed("2", "msg_a,msg_b", "4", "ünistderr".as_bytes()));
        assert_eq!(
            reply,
            Some(Reply {
                exit_code: 2,
                offered: vec!["msg_a".into(), "msg_b".into()],
                stdout: "üni".as_bytes()[..4].to_vec(),
                stderr: "ünistderr".as_bytes()[4..].to_vec(),
            })
        );
    }

    #[test]
    fn accepts_an_empty_reply() {
        let reply = parse_reply(&framed("0", "", "0", b"")).unwrap();
        assert_eq!((reply.exit_code, reply.offered.len()), (0, 0));
    }

    #[test]
    fn refuses_malformed_replies() {
        let ok = framed("0", "", "2", b"hi");
        assert!(parse_reply(&ok).is_some());
        let cases: Vec<(&str, Vec<u8>)> = vec![
            ("wrong type", edit(&ok, REPLY_TYPE, "application/json")),
            (
                "no length",
                response(
                    &[
                        ("Content-Type", REPLY_TYPE),
                        ("Bazhen-Exit-Code", "0"),
                        ("Bazhen-Offered", ""),
                        ("Bazhen-Stdout-Bytes", "0"),
                    ],
                    b"",
                ),
            ),
            (
                "chunked",
                edit(
                    &ok,
                    "Content-Length",
                    "Transfer-Encoding: chunked\r\nContent-Length",
                ),
            ),
            (
                "signed length",
                edit(&ok, "Content-Length: 2", "Content-Length: +2"),
            ),
            ("stdout past body", framed("0", "", "3", b"hi")),
            ("exit code out of range", framed("256", "", "0", b"")),
            ("exit code not a number", framed("two", "", "0", b"")),
            ("offered id not a token", framed("0", "msg a", "0", b"")),
            (
                "body shorter than length",
                edit(&ok, "Content-Length: 2", "Content-Length: 3"),
            ),
            ("not 200", edit(&ok, "200 OK", "500 Internal Server Error")),
        ];
        for (what, case) in cases {
            assert_eq!(parse_reply(&case), None, "{what}");
        }
    }

    #[test]
    fn refuses_a_body_over_the_cap() {
        let body = vec![b'x'; MAX_BODY + 1];
        assert_eq!(parse_reply(&framed("0", "", "0", &body)), None);
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
        let ok = framed("2", "", "2", b"hi");
        let (mut client, _open) = daemon_wrote(&ok, false);
        assert_eq!(read_response(&mut client, STALL).unwrap(), ok);
    }

    #[test]
    fn ignores_what_follows_the_promised_body() {
        let ok = framed("2", "", "2", b"hi");
        let (mut client, _open) = daemon_wrote(&[&ok[..], b"junk"].concat(), false);
        assert_eq!(read_response(&mut client, STALL).unwrap(), ok);
    }

    fn unframed_and_its_head() -> (Vec<u8>, Vec<u8>) {
        let unframed = edit(&framed("2", "", "2", b"hi"), "Content-Length: 2\r\n", "");
        let head = unframed[..unframed.len() - 2].to_vec();
        (unframed, head)
    }

    #[test]
    fn stops_at_the_head_of_a_reply_without_a_length_on_a_connection_held_open() {
        let (unframed, head) = unframed_and_its_head();
        let (mut client, _open) = daemon_wrote(&unframed, false);
        let read = read_response(&mut client, STALL).map_err(|e| e.kind());
        assert_eq!(read, Ok(head));
    }

    #[test]
    fn gives_up_on_a_reply_that_stops_short_of_its_length() {
        let ok = framed("2", "", "2", b"hi");
        let (mut client, _open) = daemon_wrote(&ok[..ok.len() - 1], false);
        let start = Instant::now();
        assert!(read_response(&mut client, STALL).is_err());
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "{:?}",
            start.elapsed()
        );
    }

    #[test]
    fn reads_without_waiting_once_the_closed_connection_refuses_a_timeout() {
        let unframed = edit(&framed("2", "", "2", b"hi"), "Content-Length: 2\r\n", "");
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
        let ok = framed("0", "", "2", b"hi");
        assert!(!is_truncated(&ok));
        assert!(is_truncated(&ok[..ok.len() - 1]));
        assert!(is_truncated(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\n"));
        assert!(is_truncated(b""));
        // One more byte would end a head of exactly MAX_HEAD.
        assert!(is_truncated(&[&[b'x'; MAX_HEAD][..], b"\r\n\r"].concat()));
        // Refused, not retried: no length, a head that isn't text, or more head or body than a
        // reply may have.
        assert!(!is_truncated(&edit(&ok, "Content-Length: 2\r\n", "")));
        assert!(!is_truncated(b"HTTP/1.1 200 OK\r\nX: \xff\r\n\r\n"));
        assert!(!is_truncated(&vec![b'x'; MAX_HEAD + 4]));
        let huge = (MAX_BODY + 1).to_string();
        assert!(!is_truncated(&edit(
            &ok,
            "Content-Length: 2",
            &format!("Content-Length: {huge}")
        )));
    }

    #[test]
    fn a_reply_too_long_to_accept_ends_at_its_head() {
        let ok = framed("0", "", "2", b"hi");
        let over = (MAX_BODY + 1).to_string();
        let huge = edit(&ok, "Content-Length: 2", &format!("Content-Length: {over}"));
        let padding = format!("X-Pad: {}\r\nContent-Type", "x".repeat(MAX_HEAD));
        let long_head = edit(&ok, "Content-Type", &padding);
        for refused in [huge, long_head] {
            assert_eq!(reply_end(&refused), Some(refused.len() - 2));
        }
    }

    #[test]
    fn refuses_a_repeated_header_or_an_oversized_head() {
        let ok = framed("0", "", "2", b"hi");
        let twice = edit(
            &ok,
            "Bazhen-Exit-Code: 0",
            "Bazhen-Exit-Code: 0\r\nBazhen-Exit-Code: 2",
        );
        assert_eq!(parse_reply(&twice), None);
        let padding = format!("X-Pad: {}\r\nContent-Type", "x".repeat(MAX_HEAD));
        assert_eq!(parse_reply(&edit(&ok, "Content-Type", &padding)), None);
    }

    mod properties {
        use super::*;
        use proptest::prelude::*;

        fn token() -> impl Strategy<Value = String> {
            "[A-Za-z0-9_-]{1,12}"
        }

        fn reply() -> impl Strategy<Value = Reply> {
            (
                any::<u8>(),
                prop::collection::vec(token(), 0..4),
                prop::collection::vec(any::<u8>(), 0..64),
                prop::collection::vec(any::<u8>(), 0..64),
            )
                .prop_map(|(exit, offered, stdout, stderr)| Reply {
                    exit_code: exit.into(),
                    offered,
                    stdout,
                    stderr,
                })
        }

        fn frame(reply: &Reply) -> Vec<u8> {
            let body = [reply.stdout.as_slice(), reply.stderr.as_slice()].concat();
            framed(
                &reply.exit_code.to_string(),
                &reply.offered.join(","),
                &reply.stdout.len().to_string(),
                &body,
            )
        }

        proptest! {
            #[test]
            fn reads_back_any_reply_framed_as_the_protocol_documents(reply in reply()) {
                prop_assert_eq!(parse_reply(&frame(&reply)), Some(reply));
            }

            #[test]
            fn refuses_every_reply_cut_short(reply in reply(), cut in any::<prop::sample::Index>()) {
                let whole = frame(&reply);
                let prefix = &whole[..cut.index(whole.len())];
                prop_assert_eq!(parse_reply(prefix), None);
            }

            #[test]
            fn read_a_byte_at_a_time_ends_where_each_whole_prefix_does(
                reply in reply(),
                after in prop::collection::vec(any::<u8>(), 0..16),
            ) {
                let framed = [frame(&reply), after].concat();
                let length = format!("Content-Length: {}\r\n", reply.stdout.len() + reply.stderr.len());
                let at = framed.windows(length.len()).position(|w| w == length.as_bytes()).unwrap();
                let unframed = [&framed[..at], &framed[at + length.len()..]].concat();
                for whole in [framed, unframed] {
                    let mut framing = Framing::default();
                    for k in 0..=whole.len() {
                        let end = reply_end(&whole[..k]);
                        prop_assert_eq!(framing.end_of(&whole[..k]), end);
                        if end.is_some() {
                            break;
                        }
                    }
                }
            }
        }
    }
}

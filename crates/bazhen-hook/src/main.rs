//! `bazhen-hook <event>`: the hook client a harness runs for each of Bazhen's hooks. It forwards
//! the hook's input over the daemon's Unix socket and prints the reply verbatim, knowing no
//! harness format. Outside a Bazhen agent, or on any failure, it exits 0 with no output, so the
//! harness carries on as it would without Bazhen.
//!
//! The reply's framing is documented beside `HookReply` in packages/protocol/src/mail.ts.

mod pane_title;
mod statusline;

use std::env;
use std::io::{self, Read, Write};
use std::os::unix::net::UnixStream;
use std::os::unix::process::parent_id;
use std::process::{exit, id};
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
struct Reply {
    exit_code: i32,
    offered: Vec<String>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn main() {
    let ran = match env::args().nth(1).as_deref() {
        Some("pane-title") => pane_title::run(env::args().skip(2)),
        Some("statusline-wrap") => statusline::run(env::args().skip(2)),
        _ => run(),
    };
    exit(ran.unwrap_or(0));
}

fn run() -> Option<i32> {
    let agent = env::var("BAZHEN_AGENT_ID").ok()?;
    let socket = env::var("BAZHEN_SOCKET").ok()?;
    let event = env::args().nth(1)?;
    if !is_token(&agent) || !is_token(&event) {
        return None;
    }
    let mut payload = Vec::new();
    io::stdin().read_to_end(&mut payload).ok()?;
    let request = hook_request(&payload, &agent, &event, id(), parent_id());
    let deadline = match event.as_str() {
        "wait" => WAIT_DEADLINE,
        "PostToolUse" => FOLD_DEADLINE,
        _ => HOOK_DEADLINE,
    };
    let reply = ask(&socket, &request, event == "wait", deadline)?;
    io::stdout().write_all(&reply.stdout).ok()?;
    io::stdout().flush().ok()?;
    io::stderr().write_all(&reply.stderr).ok()?;
    if !reply.offered.is_empty() {
        // The reply is already out; an ack that fails leaves the mail offered, and the daemon
        // offers it again.
        let _ = post(
            &socket,
            "/v1/hooks/ack",
            &hook_ack(&agent, &reply.offered),
            ACK_DEADLINE,
        );
    }
    Some(reply.exit_code)
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
fn ask(socket: &str, request: &[u8], waiting: bool, within: Duration) -> Option<Reply> {
    let deadline = Instant::now() + within;
    loop {
        let left = deadline
            .checked_duration_since(Instant::now())
            .filter(|d| !d.is_zero())?;
        match post(socket, "/v1/hooks", request, left) {
            Ok(response) => return parse_reply(&response),
            Err(_) if waiting => sleep(Duration::from_secs(1)),
            Err(_) => return None,
        }
    }
}

/// One HTTP/1.1 exchange; the whole response, or an error if it ended early.
fn post(socket: &str, path: &str, body: &[u8], timeout: Duration) -> io::Result<Vec<u8>> {
    let mut stream = UnixStream::connect(socket)?;
    stream.set_read_timeout(Some(timeout))?;
    stream.set_write_timeout(Some(timeout))?;
    let head = format!(
        "POST {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\n\
         Content-Length: {}\r\nConnection: close\r\n\r\n",
        body.len()
    );
    stream.write_all(head.as_bytes())?;
    stream.write_all(body)?;
    let response = read_response(&mut stream, REPLY_STALL.min(timeout))?;
    if is_truncated(&response) {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    Ok(response)
}

/// Reads one response, up to the end of the body its `Content-Length` promises, so it never
/// waits on the daemon closing the connection: a reader blocked on that close has been seen to
/// miss it and hang with the whole reply in hand. A response without a usable length is read to
/// the end of the stream, for `parse_reply` to refuse. Once the reply has begun, each read gets
/// `stall` at most, so one that stops short of its length times out rather than hangs.
fn read_response(stream: &mut UnixStream, stall: Duration) -> io::Result<Vec<u8>> {
    const LIMIT: usize = MAX_HEAD + 4 + MAX_BODY + 1;
    let mut response = Vec::new();
    let mut chunk = vec![0; 64 << 10];
    while response.len() < LIMIT {
        if let Some(end) = promised_end(&response) {
            response.truncate(end);
            break;
        }
        // What is left to read only shrinks, so the buffer can shrink with it.
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

/// Where the response ends by its own `Content-Length`, once that much of it has arrived.
fn promised_end(response: &[u8]) -> Option<usize> {
    let (head, body) = split_head(response)?;
    let length = content_length(head).filter(|&n| n <= MAX_BODY)?;
    let head_len = response.len() - body.len();
    (body.len() >= length).then_some(head_len + length)
}

/// Whether the response ended early: in its head, or short of the body its `Content-Length`
/// promises. Anything else, oversized or without the header, is refused by `parse_reply` rather
/// than retried.
fn is_truncated(response: &[u8]) -> bool {
    match split_head(response) {
        None => response.len() <= MAX_HEAD,
        Some((head, body)) => content_length(head).is_some_and(|n| n <= MAX_BODY && body.len() < n),
    }
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
fn header<'a>(head: &'a str, name: &str) -> Option<&'a str> {
    let mut values = headers(head, name);
    let value = values.next()?;
    values.next().is_none().then_some(value)
}

fn content_length(head: &str) -> Option<usize> {
    header(head, "Content-Length")?.parse().ok()
}

/// The daemon's framed reply, or None for anything else: the hook then fails open.
fn parse_reply(response: &[u8]) -> Option<Reply> {
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

    #[test]
    fn reads_a_reply_without_a_length_to_the_end_of_the_stream() {
        let unframed = edit(&framed("2", "", "2", b"hi"), "Content-Length: 2\r\n", "");
        let (mut client, _) = daemon_wrote(&unframed, true);
        assert_eq!(read_response(&mut client, STALL).unwrap(), unframed);
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
        // Refused, not retried: no length, or more head or body than a reply may have.
        assert!(!is_truncated(&edit(&ok, "Content-Length: 2\r\n", "")));
        assert!(!is_truncated(&vec![b'x'; MAX_HEAD + 1]));
        let huge = (MAX_BODY + 1).to_string();
        assert!(!is_truncated(&edit(
            &ok,
            "Content-Length: 2",
            &format!("Content-Length: {huge}")
        )));
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
        }
    }
}

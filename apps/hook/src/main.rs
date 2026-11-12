//! `bazhen-hook <event>`: the hook client a harness runs for each of Bazhen's hooks. It forwards
//! the hook's input over the daemon's Unix socket and prints the reply verbatim, knowing no
//! harness format. Outside a Bazhen agent, or on any failure, it exits 0 with no output, so the
//! harness carries on as it would without Bazhen.
//!
//! The reply's framing is documented beside `HookReply` in packages/protocol/src/mail.ts.

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
const HOOK_DEADLINE: Duration = Duration::from_secs(10 * 60);
/// The waiter outlives a daemon restart by reconnecting, and gives up before its hook's timeout.
const WAIT_DEADLINE: Duration = Duration::from_secs(23 * 3600);
const ACK_DEADLINE: Duration = Duration::from_secs(5);

#[derive(Debug, PartialEq)]
struct Reply {
    exit_code: i32,
    offered: Vec<String>,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

fn main() {
    exit(run().unwrap_or(0));
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
    let reply = ask(&socket, &request, event == "wait")?;
    io::stdout().write_all(&reply.stdout).ok()?;
    io::stdout().flush().ok()?;
    io::stderr().write_all(&reply.stderr).ok()?;
    if !reply.offered.is_empty() {
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
fn hook_request(payload: &[u8], agent: &str, event: &str, pid: u32, ppid: u32) -> Vec<u8> {
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
             \"event\":\"{event}\",\"pid\":{pid},\"ppid\":{ppid}}}"
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
fn ask(socket: &str, request: &[u8], waiting: bool) -> Option<Reply> {
    let deadline = Instant::now()
        + if waiting {
            WAIT_DEADLINE
        } else {
            HOOK_DEADLINE
        };
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
    let mut response = Vec::new();
    stream
        .take((MAX_HEAD + 4 + MAX_BODY + 1) as u64)
        .read_to_end(&mut response)?;
    if is_truncated(&response) {
        return Err(io::ErrorKind::UnexpectedEof.into());
    }
    Ok(response)
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
    let head = std::str::from_utf8(&response[..end]).ok()?;
    Some((head, &response[end + 4..]))
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
        && stdout_bytes <= length
        && offered.iter().all(|id| is_token(id));
    if !well_formed {
        return None;
    }
    Some(Reply {
        exit_code: header(head, "Bazhen-Exit-Code")?.parse::<u8>().ok()?.into(),
        offered,
        stdout: body[..stdout_bytes].to_vec(),
        stderr: body[stdout_bytes..].to_vec(),
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
}

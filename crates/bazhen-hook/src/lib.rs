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
use std::os::unix::process::parent_id;
use std::path::Path;
use std::process::id;
use std::thread::sleep;
use std::time::{Duration, Instant};

/// The client's framing, which `parse_reply` holds a reply to, for the fuzz targets to reach.
pub use bazhen_client::framing;
use bazhen_client::{Caller, Error, Limits, Method, agent_token, exchange};
use framing::{content_length, header, headers, split_head};

const PROTOCOL_VERSION: &str = "1.0";
const REPLY_TYPE: &str = "application/vnd.bazhen.hook-reply";
const MAX_BODY: usize = 1 << 20;
const MAX_HEAD: usize = 16 << 10;
/// What the hook reads of a reply: past either, the reply ends at its head and is refused.
pub const LIMITS: Limits = Limits {
    head: MAX_HEAD,
    body: MAX_BODY,
};
/// Only a backstop: the harness's own timeout for each hook ends it first.
const HOOK_DEADLINE: Duration = Duration::from_mins(10);
/// The waiter outlives a daemon restart by reconnecting, and gives up before its hook's timeout.
const WAIT_DEADLINE: Duration = Duration::from_hours(23);
const ACK_DEADLINE: Duration = Duration::from_secs(5);
/// `PostToolUse` runs on every tool call, and a fold it misses waits for a wake, so a slow daemon
/// costs a tool call at most this; with the ack after it, well inside the hook's 10 s timeout.
const FOLD_DEADLINE: Duration = Duration::from_secs(2);

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
fn post(socket: &str, path: &str, body: &[u8], timeout: Duration) -> Result<Vec<u8>, Error> {
    post_as(socket, path, body, timeout, None)
}

/// As `post`, proving the agent the request comes from with its token.
pub(crate) fn post_as(
    socket: &str,
    path: &str,
    body: &[u8],
    timeout: Duration,
    token: Option<&str>,
) -> Result<Vec<u8>, Error> {
    let caller = Caller::with_token(token.map(str::to_owned));
    exchange(
        Path::new(socket),
        Method::Post,
        path,
        body,
        &caller,
        LIMITS,
        timeout,
    )
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
        use bazhen_client::framing::{Framing, reply_end};
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
                    let mut framing = Framing::new(LIMITS);
                    for k in 0..=whole.len() {
                        let end = reply_end(&whole[..k], LIMITS);
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

//! `bazhen-hook shell-report [<time>]`: what a Bazhen shell's integration runs in the background
//! as the shell starts a line, with the line on stdin, never as an argument, which `ps` would
//! show. It sends the line to the daemon with the shell's token, and exits within `DEADLINE`
//! whatever the daemon does, so that one started before every line can't pile up. Outside a
//! Bazhen shell with the integration on, or on any failure, it sends nothing and exits 0.
//!
//! `<time>` is when the shell started the line, as `$EPOCHREALTIME` gives it; without one, now.
//! The daemon keeps a line only if it started later than the line it has.
//!
//! `bazhen-hook shell-prompt`, which the integration runs once, at the shell's first prompt, tells
//! the daemon its line editor is reading, so a restart can type a line back. It carries only the
//! token, and is bound by the same deadline.

use std::env;
use std::fmt::Write as _;
use std::io::{self, Read};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::{is_token, post};

/// The most bytes of a line the daemon keeps, as `COMMAND_LINE_MAX_BYTES` in
/// `packages/protocol/src/shells.ts`. A longer line is sent as null, never cut short.
pub const MAX_LINE: usize = 2048;

/// The longest the report may take, start to exit, however the daemon answers or doesn't.
const DEADLINE: Duration = Duration::from_secs(1);

/// The largest integer a JSON number carries exactly to the daemon.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// The shell's terminal, its token and the daemon's socket, from the shell's environment.
fn reporter() -> Option<(String, String, String)> {
    let terminal = env::var("BAZHEN_TERMINAL_ID")
        .ok()
        .filter(|t| is_token(t))?;
    let token = env::var("BAZHEN_SHELL_TOKEN").ok()?;
    let socket = env::var("BAZHEN_SOCKET").ok()?;
    Some((terminal, token, socket))
}

pub(crate) fn run_prompt() -> Option<i32> {
    let (terminal, token, socket) = reporter()?;
    let body = prompt_body(&token)?;
    within(DEADLINE, move || {
        let path = format!("/v1/shells/{terminal}/prompt");
        // Like a line's report, nothing the daemon answers changes what the shell does.
        let _ = post(&socket, &path, &body, DEADLINE);
    });
    Some(0)
}

/// The prompt report's JSON, for a token that needs no escaping.
pub fn prompt_body(token: &str) -> Option<Vec<u8>> {
    is_token(token).then(|| format!("{{\"token\":\"{token}\"}}").into_bytes())
}

pub(crate) fn run(mut args: impl Iterator<Item = String>) -> Option<i32> {
    let (terminal, token, socket) = reporter()?;
    let at = match args.next() {
        Some(time) => micros(&time)?,
        None => now()?,
    };
    within(DEADLINE, move || {
        let mut line = Vec::new();
        let read = io::stdin()
            .take(u64::try_from(MAX_LINE).unwrap_or(u64::MAX) + 1)
            .read_to_end(&mut line);
        if let (Ok(_), Some(body)) = (read, report_body(&line, at, &token)) {
            let path = format!("/v1/shells/{terminal}/report");
            // Kept, refused or never answered, the shell has nothing to do about it.
            let _ = post(&socket, &path, &body, DEADLINE);
        }
    });
    Some(0)
}

/// Runs `work` on a thread of its own and returns once it is done or `deadline` has passed,
/// whichever is first. The process exits when the command returns, ending `work` if it still runs.
fn within(deadline: Duration, work: impl FnOnce() + Send + 'static) {
    let (done, finished) = mpsc::channel();
    thread::spawn(move || {
        work();
        let _ = done.send(());
    });
    let _ = finished.recv_timeout(deadline);
}

/// The report's JSON, for a token that needs no escaping. A line that isn't UTF-8, or is longer
/// than the daemon keeps, goes as null, so the daemon drops the line it had rather than keep it.
pub fn report_body(line: &[u8], at: u64, token: &str) -> Option<Vec<u8>> {
    if !is_token(token) || at > MAX_SAFE_INTEGER {
        return None;
    }
    let command = match std::str::from_utf8(line) {
        Ok(text) if line.len() <= MAX_LINE => json_string(text),
        _ => "null".to_owned(),
    };
    Some(format!("{{\"token\":\"{token}\",\"at\":{at},\"command\":{command}}}").into_bytes())
}

fn json_string(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 2);
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            c if c.is_control() && u32::from(c) < 0x80 => {
                let _ = write!(out, "\\u{:04x}", u32::from(c));
            }
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// Microseconds since the epoch from `$EPOCHREALTIME`: whole seconds, then `.` or `,` (the
/// locale's) and a fraction of any length, which zsh and bash give at different precisions.
pub fn micros(time: &str) -> Option<u64> {
    let (seconds, fraction) = time.split_once(['.', ',']).unwrap_or((time, ""));
    let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
    if seconds.is_empty() || !digits(seconds) || !digits(fraction) {
        return None;
    }
    let mut micros: u64 = seconds.parse().ok()?;
    let mut fraction = fraction.bytes();
    for _ in 0..6 {
        let digit = fraction.next().map_or(0, |b| u64::from(b - b'0'));
        micros = micros.checked_mul(10)?.checked_add(digit)?;
    }
    (micros <= MAX_SAFE_INTEGER).then_some(micros)
}

fn now() -> Option<u64> {
    let since = SystemTime::now().duration_since(UNIX_EPOCH).ok()?;
    u64::try_from(since.as_micros()).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;
    use serde_json::Value;

    fn decoded(body: &[u8]) -> Value {
        serde_json::from_slice(body).expect("the body is JSON")
    }

    #[test]
    fn carries_the_line_exactly_as_typed() {
        let line = r#"echo "$HOME" 'a  b' \x | grep -v "\\" "#;
        let body = report_body(line.as_bytes(), 7, "tok-_1").expect("a body");
        assert_eq!(
            decoded(&body),
            serde_json::json!({ "token": "tok-_1", "at": 7, "command": line })
        );
    }

    #[test]
    fn escapes_control_characters_so_the_daemon_sees_and_refuses_them() {
        let body = report_body(b"make\nrm -rf ~\r\x1b[D\x7f", 1, "t").expect("a body");
        let text = String::from_utf8(body.clone()).expect("UTF-8");
        assert!(!text.bytes().any(|b| b < 0x20 || b == 0x7f), "{text:?}");
        assert_eq!(decoded(&body)["command"], "make\nrm -rf ~\r\x1b[D\x7f");
    }

    #[test]
    fn sends_a_line_too_long_to_keep_or_not_utf8_as_null() {
        let longest = "x".repeat(MAX_LINE);
        let commands = [
            decoded(&report_body(longest.as_bytes(), 1, "t").expect("a body"))["command"].clone(),
            decoded(&report_body(format!("{longest}x").as_bytes(), 1, "t").expect("a body"))
                ["command"]
                .clone(),
            decoded(&report_body(b"echo \xff", 1, "t").expect("a body"))["command"].clone(),
        ];
        assert_eq!(commands, [Value::from(longest), Value::Null, Value::Null]);
    }

    #[test]
    fn sends_nothing_for_a_token_that_would_need_escaping() {
        assert_eq!(report_body(b"make", 1, "a\"b"), None);
        assert_eq!(report_body(b"make", 1, ""), None);
    }

    #[test]
    fn reports_a_prompt_with_the_token_alone() {
        let body = prompt_body("tok-_1").expect("a body");
        assert_eq!(decoded(&body), serde_json::json!({ "token": "tok-_1" }));
        assert_eq!(prompt_body("a\"b"), None);
        assert_eq!(prompt_body(""), None);
    }

    #[test]
    fn reads_epochrealtime_at_any_precision_in_microseconds() {
        assert_eq!(micros("1794743826.284789"), Some(1_794_743_826_284_789));
        assert_eq!(micros("1794743822.3171467781"), Some(1_794_743_822_317_146));
        assert_eq!(micros("12,5"), Some(12_500_000));
        assert_eq!(micros("12"), Some(12_000_000));
    }

    #[test]
    fn refuses_a_time_that_is_not_epochrealtime() {
        for time in [
            "",
            ".5",
            "1.2.3",
            "-1",
            "1e5",
            " 1",
            "1.-5",
            "99999999999999999999",
        ] {
            assert_eq!(micros(time), None, "{time:?}");
        }
    }

    #[test]
    fn refuses_a_time_past_what_json_carries_exactly() {
        assert_eq!(micros("9007199254.740991"), Some(MAX_SAFE_INTEGER));
        assert_eq!(micros("9007199254.740992"), None);
    }

    #[test]
    fn gives_up_at_its_deadline_on_work_that_never_finishes() {
        let started = std::time::Instant::now();
        within(Duration::from_millis(100), || {
            thread::sleep(Duration::from_secs(30));
        });
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn returns_as_soon_as_its_work_is_done() {
        let started = std::time::Instant::now();
        within(Duration::from_secs(30), || {});
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    proptest! {
        #[test]
        fn any_line_short_enough_to_keep_arrives_whole(
            chars in proptest::collection::vec(any::<char>(), 0..200)
        ) {
            let line: String = chars.into_iter().collect();
            let body = report_body(line.as_bytes(), 1, "t").expect("a body");
            prop_assert_eq!(&decoded(&body)["command"], &Value::from(line));
        }
    }
}

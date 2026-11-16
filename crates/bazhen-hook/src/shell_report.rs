//! `bazhen-hook shell-report [<time>]`: what a Bazhen shell's integration runs as the shell starts
//! a line, with the line on stdin, never as an argument, which `ps` would show. It reads the line,
//! hands it to a copy of itself in a process group of its own, and exits at once, so the shell
//! waits on nothing and its `$!` stays the user's. The copy sends the line to the daemon with the
//! shell's token, and exits within `DEADLINE` whatever the daemon does, so that one started before
//! every line can't pile up. Outside a Bazhen shell with the integration on, or on any failure, it
//! sends nothing and exits 0.
//!
//! `<time>` is when the shell started the line, as `$EPOCHREALTIME` gives it; without one, now.
//! The daemon keeps a line only if it started later than the line it has.
//!
//! `bazhen-hook shell-prompt [--brackets] [--shell <pid>]`, which the integration runs once, as the
//! shell draws its first prompt, tells the daemon its line editor is reading, so a restart can type
//! a line back. It too hands the work to a copy of itself and exits. The shell runs it before its
//! editor takes the terminal, so the copy first waits, up to `EDITOR_DEADLINE`, for the terminal to
//! leave canonical mode, as every line editor puts it: a line typed before then would be echoed by
//! the terminal as well as by the editor, and a long one cut at the terminal's line limit. It stops
//! waiting once the shell `--shell` names is gone. `--brackets` says the editor reads a paste
//! marked with the bracketed-paste sequences whether or not it has asked for bracketed paste yet,
//! so the daemon marks it itself.

use std::env;
use std::fmt::Write as _;
use std::fs::File;
use std::io::{self, Read, Write as _};
use std::os::unix::process::CommandExt as _;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use rustix::process::{Pid, getsid};
use rustix::termios::{LocalModes, tcgetattr};

use crate::{is_token, post};

/// The most bytes of a line the daemon keeps, as `COMMAND_LINE_MAX_BYTES` in
/// `packages/protocol/src/shells.ts`. A longer line is sent as null, never cut short.
pub const MAX_LINE: usize = 2048;

/// The longest the report may take, start to exit, however the daemon answers or doesn't.
const DEADLINE: Duration = Duration::from_secs(1);

/// The longest `shell-prompt` waits for the shell's line editor to take the terminal: a prompt that
/// takes longer to draw gets no line typed back, which the daemon logs.
const EDITOR_DEADLINE: Duration = Duration::from_secs(10);

/// How often `shell-prompt` looks at the terminal's mode while it waits.
const EDITOR_POLL: Duration = Duration::from_millis(5);

/// The largest integer a JSON number carries exactly to the daemon.
const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

/// What the copy a command hands its work to is told, ahead of the command's own arguments.
const DETACHED: &str = "--detached";

/// The shell's terminal, its token and the daemon's socket, from the shell's environment.
fn reporter() -> Option<(String, String, String)> {
    let terminal = env::var("BAZHEN_TERMINAL_ID")
        .ok()
        .filter(|t| is_token(t))?;
    let token = env::var("BAZHEN_SHELL_TOKEN").ok()?;
    let socket = env::var("BAZHEN_SOCKET").ok()?;
    Some((terminal, token, socket))
}

/// Starts this program again as `command --detached args`, in a process group of its own, so the
/// shell's job control and its terminal's signals never reach it, with `stdin` as its input.
fn detach(command: &str, args: &[String], stdin: Stdio) -> Option<std::process::Child> {
    Command::new(env::current_exe().ok()?)
        .arg(command)
        .arg(DETACHED)
        .args(args)
        .stdin(stdin)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .process_group(0)
        .spawn()
        .ok()
}

/// What `shell-prompt` was asked: whether to ask for the paste to be marked, and the shell's pid.
#[derive(Debug, PartialEq)]
pub struct PromptArgs {
    brackets: bool,
    shell: Option<Pid>,
}

/// `[--brackets] [--shell <pid>]`, in either order; anything else, or a pid of 1 or less, is
/// refused.
pub fn prompt_args(args: &[String]) -> Option<PromptArgs> {
    let mut parsed = PromptArgs {
        brackets: false,
        shell: None,
    };
    let mut args = args.iter();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--brackets" => parsed.brackets = true,
            "--shell" => {
                let pid: i32 = args.next()?.parse().ok()?;
                parsed.shell = Some(Pid::from_raw((pid > 1).then_some(pid)?)?);
            }
            _ => return None,
        }
    }
    Some(parsed)
}

pub(crate) fn run_prompt(args: impl Iterator<Item = String>) -> Option<i32> {
    let args: Vec<String> = args.collect();
    if args.first().map(String::as_str) != Some(DETACHED) {
        prompt_args(&args)?;
        detach("shell-prompt", &args, Stdio::null())?;
        return Some(0);
    }
    let asked = prompt_args(args.get(1..)?)?;
    let (terminal, token, socket) = reporter()?;
    let body = prompt_body(&token, asked.brackets)?;
    // Without a terminal to read, the editor can't be told ready: no report, and no line typed.
    let tty = File::open("/dev/tty").ok()?;
    let session = getsid(None).ok()?;
    let canonical = || {
        // A shell gone is one whose editor will never read: the wait ends, and its terminal with
        // it. A terminal its runtime closes as the shell exits ends the wait as well, as tmux does.
        if let Some(shell) = asked.shell {
            in_session(shell, session, |pid| getsid(Some(pid)).ok()).then_some(())?;
        }
        tcgetattr(&tty)
            .ok()
            .map(|t| t.local_modes.contains(LocalModes::ICANON))
    };
    if !editor_reading(canonical, EDITOR_DEADLINE, EDITOR_POLL) {
        return Some(0);
    }
    drop(tty);
    within(DEADLINE, move || {
        let path = format!("/v1/shells/{terminal}/prompt");
        // Like a line's report, nothing the daemon answers changes what the shell does.
        let _ = post(&socket, &path, &body, DEADLINE);
    });
    Some(0)
}

/// Whether `shell` is still a process in the terminal's session `session`, as `sid_of` reads a
/// pid's session: false for one gone, and for its pid taken since by a process elsewhere.
fn in_session(shell: Pid, session: Pid, sid_of: impl Fn(Pid) -> Option<Pid>) -> bool {
    sid_of(shell) == Some(session)
}

/// Whether the terminal left canonical mode within `deadline`, looking every `poll`. `canonical`
/// says whether it is in canonical mode, or None when its mode can't be read, which ends the wait.
fn editor_reading(
    mut canonical: impl FnMut() -> Option<bool>,
    deadline: Duration,
    poll: Duration,
) -> bool {
    let started = Instant::now();
    loop {
        match canonical() {
            Some(false) => return true,
            None => return false,
            Some(true) if started.elapsed() >= deadline => return false,
            Some(true) => thread::sleep(poll),
        }
    }
}

/// The prompt report's JSON, for a token that needs no escaping.
pub fn prompt_body(token: &str, brackets: bool) -> Option<Vec<u8>> {
    let marked = if brackets { ",\"brackets\":true" } else { "" };
    is_token(token).then(|| format!("{{\"token\":\"{token}\"{marked}}}").into_bytes())
}

pub(crate) fn run(args: impl Iterator<Item = String>) -> Option<i32> {
    let args: Vec<String> = args.collect();
    if args.first().map(String::as_str) == Some(DETACHED) {
        return send_line(args.get(1));
    }
    // Timed here, as the shell starts the line, not as the copy gets to it.
    let at = match args.first() {
        Some(time) => micros(time)?,
        None => now()?,
    };
    let line = read_line()?;
    let stamp = format!("{}.{:06}", at / 1_000_000, at % 1_000_000);
    let mut copy = detach("shell-report", &[stamp], Stdio::piped())?;
    // The copy reads it from a pipe: the line is never in argv or the environment.
    let _ = copy.stdin.take()?.write_all(&line);
    Some(0)
}

/// The line on stdin, up to one byte more than is kept, or None if it doesn't come within
/// `DEADLINE`.
fn read_line() -> Option<Vec<u8>> {
    let (sent, got) = mpsc::channel();
    within(DEADLINE, move || {
        let mut line = Vec::new();
        let read = io::stdin()
            .take(u64::try_from(MAX_LINE).unwrap_or(u64::MAX) + 1)
            .read_to_end(&mut line);
        if read.is_ok() {
            let _ = sent.send(line);
        }
    });
    got.try_recv().ok()
}

/// The copy's half of `shell-report`: the line from its stdin, to the daemon.
fn send_line(time: Option<&String>) -> Option<i32> {
    let (terminal, token, socket) = reporter()?;
    let at = micros(time?)?;
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
        let body = prompt_body("tok-_1", false).expect("a body");
        let marked = prompt_body("tok-_1", true).expect("a body");
        assert_eq!(
            [decoded(&body), decoded(&marked)],
            [
                serde_json::json!({ "token": "tok-_1" }),
                serde_json::json!({ "token": "tok-_1", "brackets": true })
            ]
        );
        assert_eq!(prompt_body("a\"b", false), None);
        assert_eq!(prompt_body("", true), None);
    }

    #[test]
    fn reports_a_prompt_once_the_terminal_leaves_canonical_mode() {
        let mut looks = 0;
        let reading = editor_reading(
            || {
                looks += 1;
                Some(looks < 4)
            },
            Duration::from_secs(30),
            Duration::ZERO,
        );
        assert_eq!((reading, looks), (true, 4));
    }

    #[test]
    fn reports_no_prompt_for_a_terminal_still_canonical_at_the_deadline_or_unreadable() {
        let started = std::time::Instant::now();
        let canonical = editor_reading(|| Some(true), Duration::from_millis(50), Duration::ZERO);
        let unreadable = editor_reading(|| None, Duration::from_secs(30), Duration::ZERO);
        assert_eq!((canonical, unreadable), (false, false));
        assert!(
            started.elapsed() < Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
    }

    #[test]
    fn takes_prompt_flags_in_either_order_and_refuses_a_pid_that_names_no_shell() {
        let args = |a: &[&str]| prompt_args(&a.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>());
        let shell = Pid::from_raw(4242);
        assert_eq!(
            [
                args(&[]),
                args(&["--brackets", "--shell", "4242"]),
                args(&["--shell", "4242"])
            ],
            [
                Some(PromptArgs {
                    brackets: false,
                    shell: None
                }),
                Some(PromptArgs {
                    brackets: true,
                    shell
                }),
                Some(PromptArgs {
                    brackets: false,
                    shell
                }),
            ]
        );
        for refused in [
            &["--shell"][..],
            &["--shell", "1"],
            &["--shell", "0"],
            &["--shell", "-1"],
            &["--shell", "x"],
            &["--other"],
        ] {
            assert_eq!(args(refused), None, "{refused:?}");
        }
    }

    #[test]
    fn waits_on_a_shell_only_while_it_is_in_the_terminals_session() {
        let pid = |raw| Pid::from_raw(raw).expect("a pid");
        let (shell, session, elsewhere) = (pid(4242), pid(4000), pid(5000));
        let sid = |of: Option<Pid>| move |_| of;
        assert_eq!(
            [
                in_session(shell, session, sid(Some(session))),
                in_session(shell, session, sid(Some(elsewhere))),
                in_session(shell, session, sid(None)),
            ],
            [true, false, false]
        );
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

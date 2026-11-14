//! Runs inside a terminal. Writes one query, blocks until the reply, and records the latency.
//!
//! `bz-probe <cpr|da1|da2|xtversion|osc10|osc11> <out> [count]` appends one JSON line per
//! query to `out`. `bz-probe esc <out> [count]` records, per lone Esc read from the terminal,
//! the wall-clock microsecond it arrived, for the driver to compare with when it sent it.

use std::fs::OpenOptions;
use std::io::{self, Write as _};
use std::process::ExitCode;
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use rustix::event::{PollFd, PollFlags, Timespec, poll};
use rustix::termios::{OptionalActions, tcgetattr, tcsetattr};

const TIMEOUT_MS: i64 = 1000;

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().collect();
    let (Some(kind), Some(out)) = (args.get(1), args.get(2)) else {
        return ExitCode::FAILURE;
    };
    let count: usize = args.get(3).and_then(|c| c.parse().ok()).unwrap_or(20);
    match run(kind, out, count) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            let _ = append(out, &format!("{{\"error\":{:?}}}", e.to_string()));
            ExitCode::FAILURE
        }
    }
}

fn run(kind: &str, out: &str, count: usize) -> io::Result<()> {
    let stdin = io::stdin();
    let saved = tcgetattr(&stdin)?;
    let mut raw = saved.clone();
    raw.make_raw();
    tcsetattr(&stdin, OptionalActions::Now, &raw)?;
    let result = if kind == "esc" {
        escapes(out, count)
    } else {
        queries(kind, out, count)
    };
    tcsetattr(&stdin, OptionalActions::Now, &saved)?;
    result
}

fn queries(kind: &str, out: &str, count: usize) -> io::Result<()> {
    type Done = fn(&[u8]) -> bool;
    let (query, done): (&[u8], Done) = match kind {
        "cpr" => (b"\x1b[6n", |r| r.ends_with(b"R")),
        "da1" => (b"\x1b[c", |r| r.ends_with(b"c")),
        "da2" => (b"\x1b[>c", |r| r.ends_with(b"c")),
        "xtversion" => (b"\x1b[>q", |r| r.ends_with(b"\x1b\\")),
        "osc10" => (b"\x1b]10;?\x1b\\", |r| {
            r.ends_with(b"\x1b\\") || r.ends_with(b"\x07")
        }),
        "osc11" => (b"\x1b]11;?\x1b\\", |r| {
            r.ends_with(b"\x1b\\") || r.ends_with(b"\x07")
        }),
        _ => return Err(io::Error::new(io::ErrorKind::InvalidInput, "unknown query")),
    };
    append(out, &format!("{{\"ready\":{kind:?}}}"))?;
    for i in 0..count {
        let started = Instant::now();
        let mut stdout = io::stdout();
        stdout.write_all(query)?;
        stdout.flush()?;
        let mut reply = Vec::new();
        let mut byte = [0u8; 1];
        let answered = loop {
            let left =
                TIMEOUT_MS - i64::try_from(started.elapsed().as_millis()).unwrap_or(i64::MAX);
            if left <= 0 || !readable(left)? {
                break false;
            }
            // Straight from the fd: std's Stdin buffers, and poll can't see what it holds.
            let n = rustix::io::read(io::stdin(), &mut byte)?;
            if n == 0 {
                break false;
            }
            reply.extend_from_slice(&byte);
            if done(&reply) {
                break true;
            }
        };
        let micros = started.elapsed().as_micros();
        let reply = String::from_utf8_lossy(&reply).replace('\x1b', "ESC");
        append(
            out,
            &format!(
                "{{\"kind\":{kind:?},\"i\":{i},\"answered\":{answered},\"micros\":{micros},\"reply\":{reply:?}}}"
            ),
        )?;
    }
    Ok(())
}

fn escapes(out: &str, count: usize) -> io::Result<()> {
    append(out, "{\"ready\":\"esc\"}")?;
    let mut byte = [0u8; 1];
    let mut seen = 0;
    while seen < count {
        if rustix::io::read(io::stdin(), &mut byte)? == 0 {
            break;
        }
        if byte == [0x1b] {
            let at = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_micros();
            append(
                out,
                &format!("{{\"kind\":\"esc\",\"i\":{seen},\"atMicros\":{at}}}"),
            )?;
            seen += 1;
        }
    }
    Ok(())
}

fn readable(timeout_ms: i64) -> io::Result<bool> {
    let stdin = io::stdin();
    let mut fds = [PollFd::new(&stdin, PollFlags::IN)];
    let timeout = Timespec {
        tv_sec: timeout_ms / 1000,
        tv_nsec: (timeout_ms % 1000) * 1_000_000,
    };
    Ok(poll(&mut fds, Some(&timeout))? > 0)
}

fn append(path: &str, line: &str) -> io::Result<()> {
    let mut file = OpenOptions::new().create(true).append(true).open(path)?;
    file.write_all(format!("{line}\n").as_bytes())
}

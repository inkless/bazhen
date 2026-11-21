//! `bazhen-daemon start` (`detach.ts`): the daemon in a session of its own, outliving the terminal
//! that started it, with its output in the state directory.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode, Stdio};
use std::time::{Duration, Instant};

use crate::env::{Env, EnvRules, hand_off};
use crate::probe::{Answer, probe, silence};
use crate::session::in_own_session;

/// The argument the started daemon is run with: it serves only as the leader of the session it
/// was started in.
pub(crate) const SESSION_ARG: &str = "--session";

const READY_WITHIN: Duration = Duration::from_secs(10);
const POLL: Duration = Duration::from_millis(200);
const LOG_TAIL_LINES: usize = 20;

/// Said of a daemon of another build, which this one can't speak to.
pub(crate) const ANOTHER_BUILD: &str =
    "the daemon runs another build of Bazhen: restart it with `bazhen stop`, then `bazhen start`";

/// What starting needs.
#[derive(Debug)]
pub(crate) struct Detach<'a> {
    /// This program, run again to serve.
    pub(crate) exe: &'a Path,
    pub(crate) socket: &'a Path,
    pub(crate) state: &'a Path,
    pub(crate) url: &'a str,
    pub(crate) protocol_id: &'a str,
    pub(crate) env: &'a Env,
    pub(crate) rules: &'a EnvRules,
}

/// Starts the daemon unless one answers already, and says whether it came up. Output that can't
/// be written has no one to tell.
pub(crate) fn detach(o: &Detach<'_>, out: &mut dyn Write, err: &mut dyn Write) -> ExitCode {
    match probe(o.socket) {
        Answer::Nothing => {}
        Answer::Silent => {
            let _ = writeln!(err, "{}", silence(&o.socket.display().to_string()));
            return ExitCode::FAILURE;
        }
        Answer::Daemon { protocol_id } => {
            let _ = writeln!(out, "bazhen is already running at {}", o.url);
            if protocol_id.as_deref() != Some(o.protocol_id) {
                let _ = writeln!(out, "  warning: {ANOTHER_BUILD}");
            }
            return ExitCode::SUCCESS;
        }
    }
    let log = o.state.join("daemon.log");
    if let Err(e) = spawn(o, &log) {
        let _ = writeln!(err, "bazhen can't start the daemon: {e}");
        return ExitCode::FAILURE;
    }
    let begun = Instant::now();
    while begun.elapsed() < READY_WITHIN {
        if matches!(probe(o.socket), Answer::Daemon { .. }) {
            let _ = writeln!(out, "bazhen is running at {}", o.url);
            return ExitCode::SUCCESS;
        }
        std::thread::sleep(POLL);
    }
    let text = std::fs::read(&log).unwrap_or_default();
    let _ = writeln!(
        err,
        "bazhen did not start within {} s; {} ends:\n{}",
        READY_WITHIN.as_secs(),
        log.display(),
        tail(&String::from_utf8_lossy(&text), LOG_TAIL_LINES)
    );
    ExitCode::FAILURE
}

/// The daemon, run with its output appended to `log`, from `/` rather than the starting shell's
/// directory, which it would otherwise hold open, in a session of its own from the fork, and with
/// the environment handed off. It is left to run: it outlives this process.
fn spawn(o: &Detach<'_>, log: &PathBuf) -> std::io::Result<()> {
    let out = OpenOptions::new().create(true).append(true).open(log)?;
    let err = out.try_clone()?;
    let at = jiff::Timestamp::now();
    in_own_session(&mut Command::new(o.exe))
        .arg(SESSION_ARG)
        .current_dir("/")
        .stdin(Stdio::null())
        .stdout(out)
        .stderr(err)
        .env_clear()
        .envs(hand_off(o.env, o.rules, at))
        .spawn()
        .map(drop)
}

/// The last `lines` lines of `text`, without its trailing newlines.
fn tail(text: &str, lines: usize) -> String {
    let all: Vec<&str> = text.trim_end().split('\n').collect();
    all.get(all.len().saturating_sub(lines)..)
        .unwrap_or_default()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use std::process::Stdio;

    use rustix::process::{Pid, getsid};

    use super::*;

    /// The session `command`'s child is in, read while it waits on its stdin, then let end by
    /// closing that.
    fn session_of(command: &mut Command) -> (Pid, Pid) {
        let mut child = command
            .args(["-c", "read line || true"])
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = Pid::from_child(&child);
        let sid = getsid(Some(pid)).unwrap();
        drop(child.stdin.take());
        assert!(child.wait().unwrap().success());
        (sid, pid)
    }

    #[test]
    fn the_daemon_leads_a_session_of_its_own_from_the_fork_and_a_plain_child_does_not() {
        let (session, leader) = session_of(in_own_session(&mut Command::new("/bin/sh")));
        let (inherited, child) = session_of(&mut Command::new("/bin/sh"));
        assert_eq!(session, leader);
        assert_ne!(inherited, child);
    }

    #[test]
    fn the_log_tail_is_its_last_lines_without_trailing_newlines() {
        let log = (1..=25).fold(String::new(), |log, n| log + &format!("line {n}\n"));
        assert_eq!(
            [tail(&log, 20), tail("one\ntwo\n\n", 20), tail("", 20)],
            [
                (6..=25)
                    .map(|n| format!("line {n}"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                "one\ntwo".to_owned(),
                String::new()
            ]
        );
    }
}

//! A terminal's child: learning that it exited and how, and ending it on close.

use std::io;
use std::os::fd::BorrowedFd;
use std::time::{Duration, Instant};

use crate::signals::{self, Wakeups};
use bazhen_holder_proto::body::{ExitCode, ExitStatus};
use rustix::process::{Pid, Signal, WaitOptions, kill_process_group, waitpid};

/// How long a close waits after `SIGHUP` before it sends `SIGKILL`.
pub const CLOSE_GRACE: Duration = Duration::from_secs(2);

/// Turns `SIGCHLD` into a readable fd, for the holder's `poll`. Only one exists at a time in a
/// holder; the handler is removed when it drops.
#[derive(Debug)]
pub struct Reaper(Wakeups);

impl Reaper {
    /// # Errors
    ///
    /// When no socket pair can be made or the handler can't be installed.
    pub fn new() -> io::Result<Self> {
        Wakeups::new(libc::SIGCHLD).map(Self)
    }

    /// Readable once a `SIGCHLD` has arrived since the last `clear`.
    pub fn fd(&self) -> BorrowedFd<'_> {
        self.0.fd()
    }

    /// Empties the wake-ups, so `fd` waits for the next `SIGCHLD`.
    pub fn clear(&self) {
        self.0.clear();
    }
}

/// A close under way: `SIGHUP` sent, and `SIGKILL` due at `kill_at` unless the child is reaped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Closing {
    kill_at: Instant,
    killed: bool,
}

/// The child that leads the terminal's session. Its pid is its process group's and its session's.
///
/// Nothing here signals on drop: a terminal ends only by `close`, never because a handle went away.
#[derive(Debug)]
pub struct ChildProcess {
    pid: Pid,
    exit: Option<ExitStatus>,
    closing: Option<Closing>,
}

impl ChildProcess {
    pub(crate) fn new(pid: Pid) -> Self {
        Self {
            pid,
            exit: None,
            closing: None,
        }
    }

    pub const fn pid(&self) -> Pid {
        self.pid
    }

    /// How the child ended, once it has been reaped.
    pub fn exit(&self) -> Option<&ExitStatus> {
        self.exit.as_ref()
    }

    /// Reaps the child if it has exited, and returns its status the one time it is reaped. Only
    /// this child is waited for, so no other process's status is ever taken.
    pub fn reap(&mut self) -> Option<&ExitStatus> {
        if self.exit.is_some() {
            return None;
        }
        let status = loop {
            match waitpid(Some(self.pid), WaitOptions::NOHANG) {
                Ok(None) => return None,
                Ok(Some((_, status))) => {
                    break status_of(status.exit_status(), status.terminating_signal())?;
                }
                Err(rustix::io::Errno::INTR) => {}
                // ECHILD: the child is no longer ours to wait for, so how it ended is lost.
                Err(_) => break ExitStatus::Unknown,
            }
        };
        self.exit = Some(status);
        self.exit.as_ref()
    }

    /// Starts ending the child: `SIGHUP` and then `SIGCONT`, since a stopped process acts on HUP
    /// only once continued, to its group and to `foreground`, the terminal's foreground group
    /// (`Pty::foreground_group`). `close_step` sends `SIGKILL` once `CLOSE_GRACE` has passed. A
    /// child already reaped is sent nothing: its group's number may since have been reused.
    pub fn close(&mut self, foreground: Option<Pid>, now: Instant) {
        if self.exit.is_some() || self.closing.is_some() {
            return;
        }
        for signal in [Signal::HUP, Signal::CONT] {
            self.signal_groups(foreground, signal);
        }
        self.closing = Some(Closing {
            kill_at: now + CLOSE_GRACE,
            killed: false,
        });
    }

    /// When the close next needs a `close_step`: the kill deadline, until the kill is sent.
    pub fn close_deadline(&self) -> Option<Instant> {
        match self.closing {
            Some(Closing {
                kill_at,
                killed: false,
            }) if self.exit.is_none() => Some(kill_at),
            _ => None,
        }
    }

    /// Sends `SIGKILL` to the child's group and to `foreground`, the terminal's foreground group
    /// read again now, since the one read at `close` may have ended and its number been reused,
    /// once the close's grace has passed and the child still hasn't been reaped.
    pub fn close_step(&mut self, foreground: Option<Pid>, now: Instant) {
        if self.close_deadline().is_some_and(|kill_at| now >= kill_at) {
            self.signal_groups(foreground, Signal::KILL);
            if let Some(closing) = &mut self.closing {
                closing.killed = true;
            }
        }
    }

    fn signal_groups(&self, foreground: Option<Pid>, signal: Signal) {
        let groups = [
            Some(self.pid),
            foreground.filter(|group| *group != self.pid),
        ];
        for group in groups.into_iter().flatten() {
            match kill_process_group(group, signal) {
                // ESRCH: the group has already ended, which is what the signal was for.
                Ok(()) | Err(rustix::io::Errno::SRCH) => {}
                // EPERM, say: the foreground group is another user's (a `sudo` in the
                // foreground), which a close can't end. The other group still gets the signal.
                Err(error) => tracing::warn!(
                    group = group.as_raw_nonzero(),
                    signal = signals::name(signal.as_raw()),
                    %error,
                    "could not signal a group"
                ),
            }
        }
    }
}

/// The status `waitpid` reports: a code, or the signal that ended it. `None` for a stop or a
/// continue, which aren't an end.
fn status_of(code: Option<i32>, signal: Option<i32>) -> Option<ExitStatus> {
    match (code, signal) {
        (Some(code), _) => Some(
            ExitCode::new(i64::from(code))
                .map_or(ExitStatus::Unknown, |code| ExitStatus::Exited { code }),
        ),
        (None, Some(signal)) => Some(ExitStatus::Signalled {
            signal: signals::name(signal),
        }),
        (None, None) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_code_is_an_exit_with_that_code() {
        let status = status_of(Some(7), None);
        assert!(matches!(status, Some(ExitStatus::Exited { code }) if code.get() == 7));
    }

    #[test]
    fn a_signal_is_named_as_the_protocol_names_it() {
        assert_eq!(
            status_of(None, Some(libc::SIGTERM)),
            Some(ExitStatus::Signalled {
                signal: "SIGTERM".to_owned()
            })
        );
    }

    #[test]
    fn a_stop_is_not_an_end() {
        assert_eq!(status_of(None, None), None);
    }

    /// Runs `close` on a live group that reports each signal it gets, standing in for a group whose
    /// number was reused after its child was reaped, then ends the group with `SIGUSR1` and returns
    /// what it reported after it was armed.
    fn signals_seen_by_a_stand_in(close: impl FnOnce(Pid)) -> (std::process::ExitStatus, String) {
        use std::io::{BufRead as _, BufReader, Read as _};
        use std::os::unix::process::CommandExt as _;
        use std::process::{Command, Stdio};

        let script = "trap 'echo hup' HUP; trap 'echo usr1; exit 0' USR1; echo armed
            i=0; while [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done";
        let mut group = Command::new("sh")
            .args(["-c", script])
            .process_group(0)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(group.stdout.take().unwrap());
        let mut armed = String::new();
        stdout.read_line(&mut armed).unwrap();
        assert_eq!(armed, "armed\n");
        let pid = Pid::from_child(&group);
        close(pid);
        rustix::process::kill_process(pid, Signal::USR1).unwrap();
        let status = group.wait().unwrap();
        let mut rest = String::new();
        stdout.read_to_string(&mut rest).unwrap();
        (status, rest)
    }

    #[test]
    fn a_close_of_a_reaped_child_signals_nothing() {
        let (status, seen) = signals_seen_by_a_stand_in(|pid| {
            let mut child = ChildProcess {
                pid,
                exit: Some(ExitStatus::Unknown),
                closing: None,
            };
            let now = Instant::now();
            child.close(Some(pid), now);
            child.close_step(Some(pid), now + CLOSE_GRACE);
        });
        assert!(status.success(), "{status:?}");
        assert_eq!(seen, "usr1\n");
    }

    #[test]
    fn a_child_reaped_during_the_grace_is_not_killed() {
        let (status, seen) = signals_seen_by_a_stand_in(|pid| {
            let now = Instant::now();
            let mut child = ChildProcess {
                pid,
                exit: Some(ExitStatus::Unknown),
                closing: Some(Closing {
                    kill_at: now + CLOSE_GRACE,
                    killed: false,
                }),
            };
            assert_eq!(child.close_deadline(), None);
            child.close_step(Some(pid), now + CLOSE_GRACE);
        });
        assert!(status.success(), "{status:?}");
        assert_eq!(seen, "usr1\n");
    }
}

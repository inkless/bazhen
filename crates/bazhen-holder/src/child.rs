//! A terminal's child: learning that it exited and how, and ending it on close.

use std::io;
use std::os::fd::BorrowedFd;
use std::time::{Duration, Instant};

use crate::guard::{self, Refused, SendError};
use crate::session::{Ending, Session};
use crate::signals::{self, Wakeups};
use bazhen_holder_proto::body::{self, ExitCode, ExitStatus};
use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, WaitOptions, waitid, waitpid};

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

/// Why `ChildProcess::signal` sent nothing.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignalRefused {
    /// The child has exited, or its group has nothing left to signal.
    Exited,
    Failed(rustix::io::Errno),
    /// The holder's own check found the group not the child's (`guard`).
    Guarded(Refused),
}

/// The child that leads the terminal's session. Its pid is its process group's and its session's.
///
/// Its exit is seen without reaping it, so that its pid, the session's id, can't be given to
/// another process while anything of its session may still run: a close, or a respawn that
/// retires it, ends the session first, and only then is it reaped. A terminal that has exited and
/// isn't closed shows its leader as a zombie until then.
///
/// Nothing here signals on drop: a terminal ends only by `close`, never because a handle went away.
#[derive(Debug)]
pub struct ChildProcess {
    pid: Pid,
    exit: Option<ExitStatus>,
    reaped: bool,
    ending: Option<Ending>,
    /// Its session couldn't be proven the child's, so it is never signalled, and ends with the
    /// child's exit.
    abandoned: bool,
}

impl ChildProcess {
    pub(crate) fn new(pid: Pid) -> Self {
        Self {
            pid,
            exit: None,
            reaped: false,
            ending: None,
            abandoned: false,
        }
    }

    pub const fn pid(&self) -> Pid {
        self.pid
    }

    /// How the child ended, once its exit has been seen.
    pub fn exit(&self) -> Option<&ExitStatus> {
        self.exit.as_ref()
    }

    /// Looks for the child's exit, leaving it unreaped, and returns its status the one time it is
    /// seen. Only this child is waited for, so no other process's status is ever taken.
    pub fn poll_exit(&mut self) -> Option<&ExitStatus> {
        if self.exit.is_some() {
            return None;
        }
        let status = loop {
            match waitid(
                WaitId::Pid(self.pid),
                WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
            ) {
                Ok(None) => return None,
                Ok(Some(status)) => {
                    break status_of(status.exit_status(), status.terminating_signal())?;
                }
                Err(rustix::io::Errno::INTR) => {}
                // ECHILD: the child is no longer ours to wait for, so how it ended is lost, and
                // its pid may already be another's.
                Err(_) => {
                    self.reaped = true;
                    break ExitStatus::Unknown;
                }
            }
        };
        self.exit = Some(status);
        self.exit.as_ref()
    }

    /// Starts ending the child's whole session (`session::Ending`). A child already reaped is sent
    /// nothing: its pid, the session's id, may since be another's.
    pub fn close(&mut self, now: Instant) {
        if self.reaped || self.abandoned || self.ending.is_some() {
            return;
        }
        match Session::led_by(self.pid) {
            Ok(session) => self.ending = Some(Ending::start(session, now)),
            Err(refused) => {
                tracing::error!(%refused, "won't end a session not proven the child's");
                self.abandoned = true;
            }
        }
    }

    /// Whether the child has exited and its session been ended, or given up on.
    pub fn ended(&self) -> bool {
        self.exit.is_some()
            && (self.reaped || self.abandoned || self.ending.as_ref().is_some_and(Ending::is_over))
    }

    /// Sends `signal` to the child's process group, and only until its exit is seen. Until it is
    /// reaped its pid, which is its group's, can't be given to another process, and as a session
    /// leader it can't leave the group.
    ///
    /// # Errors
    ///
    /// `Exited` once the child has exited, or when the group is gone (`ESRCH`, as macOS may say
    /// of a group left with only the unreaped child's zombie); `Failed` for any other refusal.
    pub fn signal(&self, signal: body::Signal) -> Result<(), SignalRefused> {
        if self.exit.is_some() {
            return Err(SignalRefused::Exited);
        }
        let signal = match signal {
            body::Signal::Sigint => Signal::INT,
            body::Signal::Sigterm => Signal::TERM,
            body::Signal::Sighup => Signal::HUP,
            body::Signal::Sigkill => Signal::KILL,
        };
        match guard::signal_group(self.pid, signal) {
            Ok(()) => Ok(()),
            Err(SendError::Os(rustix::io::Errno::SRCH)) => Err(SignalRefused::Exited),
            Err(SendError::Os(errno)) => Err(SignalRefused::Failed(errno)),
            Err(SendError::Refused(refused)) => Err(SignalRefused::Guarded(refused)),
        }
    }

    /// When the close next needs a `close_step`.
    pub fn close_deadline(&self) -> Option<Instant> {
        if self.reaped {
            return None;
        }
        self.ending
            .as_ref()
            .and_then(|ending| ending.deadline(self.exit.is_some()))
    }

    /// Makes the close's pass that is due, and reaps the child once its session has ended.
    pub fn close_step(&mut self, now: Instant) {
        if self.reaped {
            return;
        }
        let exited = self.exit.is_some();
        if let Some(ending) = &mut self.ending {
            ending.step(exited, now);
        }
        if self.ended() {
            self.reap();
        }
    }

    fn reap(&mut self) {
        loop {
            match waitpid(Some(self.pid), WaitOptions::NOHANG) {
                Err(rustix::io::Errno::INTR) => {}
                Ok(None) => return,
                Ok(Some(_)) | Err(_) => break,
            }
        }
        self.reaped = true;
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

    /// Runs `close` on a live session leader that reports each signal it gets, standing in for a
    /// session whose number was reused after its child was reaped, then ends it with `SIGUSR1` and
    /// returns what it reported after it was armed.
    fn signals_seen_by_a_stand_in(close: impl FnOnce(Pid)) -> (std::process::ExitStatus, String) {
        use std::io::{BufRead as _, BufReader, Read as _};
        use std::process::{Command, Stdio};

        let script = "trap 'echo hup' HUP; trap 'echo usr1; exit 0' USR1; echo armed
            i=0; while [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done";
        let mut leader = Command::new("perl")
            .args([
                "-MPOSIX",
                "-e",
                "POSIX::setsid() or die; exec 'sh', '-c', $ARGV[0]",
            ])
            .arg(script)
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(leader.stdout.take().unwrap());
        let mut armed = String::new();
        stdout.read_line(&mut armed).unwrap();
        assert_eq!(armed, "armed\n");
        let pid = Pid::from_child(&leader);
        assert_eq!(rustix::process::getsid(Some(pid)).unwrap(), pid);
        close(pid);
        bazhen_test_signal::signal(pid.as_raw_nonzero().get(), Signal::USR1).unwrap();
        let status = leader.wait().unwrap();
        let mut rest = String::new();
        stdout.read_to_string(&mut rest).unwrap();
        (status, rest)
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_close_of_a_reaped_child_signals_nothing() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (status, seen) = signals_seen_by_a_stand_in(|pid| {
            let mut child = ChildProcess {
                pid,
                exit: Some(ExitStatus::Unknown),
                reaped: true,
                ending: None,
                abandoned: false,
            };
            let now = Instant::now();
            child.close(now);
            child.close_step(now + CLOSE_GRACE);
            assert!(child.ended());
        });
        assert!(status.success(), "{status:?}");
        assert_eq!(seen, "usr1\n");
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_signal_after_the_exit_is_refused_and_sends_nothing() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (status, seen) = signals_seen_by_a_stand_in(|pid| {
            let child = ChildProcess {
                pid,
                exit: Some(ExitStatus::Unknown),
                reaped: false,
                ending: None,
                abandoned: false,
            };
            assert_eq!(
                child.signal(body::Signal::Sighup),
                Err(SignalRefused::Exited)
            );
        });
        assert!(status.success(), "{status:?}");
        assert_eq!(seen, "usr1\n");
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_signal_to_a_live_child_reaches_its_group() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (_, seen) = signals_seen_by_a_stand_in(|pid| {
            let child = ChildProcess::new(pid);
            child.signal(body::Signal::Sighup).unwrap();
        });
        assert_eq!(seen, "hup\nusr1\n");
    }

    #[test]
    #[ignore = "signals processes; runs in pnpm test:real rust"]
    fn a_child_reaped_during_the_grace_is_not_killed() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (status, seen) = signals_seen_by_a_stand_in(|pid| {
            let now = Instant::now();
            let mut child = ChildProcess::new(pid);
            child.close(now);
            child.close_step(now);
            child.exit = Some(ExitStatus::Unknown);
            child.reaped = true;
            assert_eq!(child.close_deadline(), None);
            child.close_step(now + CLOSE_GRACE);
        });
        assert!(status.success(), "{status:?}");
        assert_eq!(seen, "hup\nusr1\n");
    }
}

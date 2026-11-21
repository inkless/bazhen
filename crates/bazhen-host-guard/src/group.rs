//! Commands run in a process group of their own, which is ended whole once they outlive their
//! time.

use std::io;
use std::process::{ExitStatus, Stdio};
use std::time::Duration;

use rustix::process::{Pid, Signal, WaitId, WaitIdOptions};
use tokio::io::AsyncRead;
use tokio::process::{Child, Command};
use tokio::time::{Instant, timeout, timeout_at};

use crate::{Error, Target, Unsafe, send};

/// How long a killed group's leader is waited for before it is left to tokio to reap.
const REAP_GRACE: Duration = Duration::from_secs(1);
/// The deadline of a run whose limit is past what an `Instant` can hold.
const FAR: Duration = Duration::from_hours(100 * 365 * 24);

/// A child leading a process group of its own. Its group is reached only through `signal`, and
/// only while the kernel says the child is unreaped: until then its pid is held, so no other group
/// can take the number. Dropped, as a run given up on is, it kills its group.
struct OwnGroup {
    child: Child,
    leader: Pid,
}

impl OwnGroup {
    fn spawn(command: &mut Command) -> io::Result<Self> {
        let child = command.process_group(0).spawn()?;
        let leader = child
            .id()
            .and_then(|id| i32::try_from(id).ok())
            .and_then(Pid::from_raw)
            .ok_or_else(|| io::Error::other("the started child has no pid"))?;
        Ok(Self { child, leader })
    }

    /// Whether the group was still there. A floor that couldn't read this process's ancestry, as
    /// when an ancestor exits mid-walk, is asked once more; its own group, unknown, stays so.
    fn signal(&self, signal: Signal) -> Result<bool, Error> {
        match self.signal_once(signal) {
            Err(Error::Unsafe {
                why: Unsafe::AncestryUnread,
                ..
            }) => self.signal_once(signal),
            sent => sent,
        }
    }

    fn signal_once(&self, signal: Signal) -> Result<bool, Error> {
        if self.child.id().is_none() || !unreaped(self.leader) {
            return Err(Error::Unsafe {
                target: Target {
                    leader: self.leader,
                },
                why: Unsafe::Reaped,
            });
        }
        send(self.leader, signal)
    }

    /// Kills the group, then reaps its leader if it goes within `REAP_GRACE`.
    async fn end(&mut self) -> Result<(), Error> {
        self.signal(Signal::KILL)?;
        // A leader not reaped in time is reaped by tokio once its child is dropped.
        let _ = timeout(REAP_GRACE, self.child.wait()).await;
        Ok(())
    }
}

impl Drop for OwnGroup {
    fn drop(&mut self) {
        // Refused for a leader already reaped, which is every run that ended.
        let _ = self.signal(Signal::KILL);
    }
}

/// Whether the kernel holds `leader` as this process's child, running or exited, and not yet
/// reaped. Anything else, a leader reaped by something but its `Child` included, is no.
fn unreaped(leader: Pid) -> bool {
    let unreaped = WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT;
    rustix::process::waitid(WaitId::Pid(leader), unreaped).is_ok()
}

/// How a bounded run ended.
#[derive(Debug)]
pub enum Ended {
    /// It exited, or a signal from elsewhere ended it.
    Exited(ExitStatus),
    /// It outlived its time, and its group was killed.
    TimedOut,
    /// It couldn't be started: most often, there is no such command.
    Unstarted(io::Error),
    /// It was started but couldn't be waited for: something else reaped it, so its group, whose
    /// number may now be another's, was left alone.
    Unwaited(io::Error),
}

/// Runs `command` with no stdin, in a process group of its own, and kills that group if the run
/// hasn't ended by `limit`: the command, its output closed, and its exit. Its output is read and
/// dropped, so a member of its group that holds the output open is still within the limit. The
/// command's program, arguments and environment are its caller's; nothing is run through a shell
/// unless the caller names one. A member that closes its output and outlives its leader's exit is
/// left running, as in TypeScript: once its leader is reaped, the group's number is free.
///
/// # Errors
///
/// Only when the group of a run past its limit couldn't be killed: the floor refused it, twice
/// where it couldn't read this process's ancestry, or the kill failed. The group is then left running. How the command itself ended is
/// never an error.
pub async fn run_bounded(mut command: Command, limit: Duration) -> Result<Ended, Error> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let start = Instant::now();
    let deadline = start.checked_add(limit).unwrap_or(start + FAR);
    let mut group = match OwnGroup::spawn(&mut command) {
        Ok(group) => group,
        Err(e) => return Ok(Ended::Unstarted(e)),
    };
    let out = group.child.stdout.take();
    let err = group.child.stderr.take();
    // The output is read to its end before the leader is waited for, so a leader that has exited
    // while a member of its group still holds the output is still unreaped when the deadline kills
    // that group.
    let read = futures_util::future::join(drain(out), drain(err));
    if timeout_at(deadline, read).await.is_err() {
        group.end().await?;
        return Ok(Ended::TimedOut);
    }
    Ok(match timeout_at(deadline, group.child.wait()).await {
        Ok(Ok(status)) => Ended::Exited(status),
        Ok(Err(e)) => Ended::Unwaited(e),
        Err(_) => {
            group.end().await?;
            Ended::TimedOut
        }
    })
}

/// Reads `pipe` to its end, keeping nothing. A read that fails ends it.
async fn drain(pipe: Option<impl AsyncRead + Unpin>) {
    if let Some(mut pipe) = pipe {
        let _ = tokio::io::copy(&mut pipe, &mut tokio::io::sink()).await;
    }
}

#[cfg(test)]
mod tests {
    use std::future::Future;
    use std::io::ErrorKind;
    use std::path::{Path, PathBuf};
    use std::time::Duration;

    use rustix::process::{Pid, Signal, WaitOptions};
    use tokio::process::Command;

    use super::{Ended, OwnGroup, run_bounded};
    use crate::{Error, Target, Unsafe};

    fn block_on<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(future)
    }

    fn sh(script: &str) -> Command {
        let mut command = Command::new("sh");
        command.args(["-c", script]);
        command
    }

    fn ran(command: Command, limit: Duration) -> Ended {
        block_on(run_bounded(command, limit)).unwrap()
    }

    /// Where a test's script writes the pid of a process it starts, named for the test.
    fn pid_file(test: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "bazhen-host-guard-{test}-{}",
            rustix::process::getpid().as_raw_pid()
        ));
        let _ = std::fs::remove_file(&path);
        path
    }

    fn pid_in(path: &Path) -> Pid {
        let line = std::fs::read_to_string(path).unwrap();
        std::fs::remove_file(path).unwrap();
        Pid::from_raw(line.trim().parse().unwrap()).unwrap()
    }

    /// Whether `pid` has ended: no process, or one exited and not yet reaped by whoever its
    /// parent now is, as `ps` reads it on Linux and macOS alike. A `ps` that can't run fails the
    /// test, rather than read as an end.
    fn ended(pid: Pid) -> bool {
        let out = std::process::Command::new("ps")
            .args(["-o", "stat=", "-p", &pid.as_raw_pid().to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8(out.stdout).unwrap();
        let state = state.trim();
        assert!(out.status.success() || state.is_empty(), "ps: {state}");
        state.is_empty() || state.starts_with('Z')
    }

    /// Whether `pid` ends within a few seconds: the kernel delivers a group's SIGKILL at once, but
    /// the process is gone only once it is reaped.
    fn ends_soon(pid: Pid) -> bool {
        for _ in 0..100 {
            if ended(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        false
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn answers_how_a_run_that_ends_in_time_exited() {
        bazhen_test_signal::require_sandbox().unwrap();
        let run = ran(
            sh("echo out; echo err >&2; exit 3"),
            Duration::from_secs(10),
        );
        let Ended::Exited(status) = run else {
            panic!("{run:?}")
        };
        assert_eq!(status.code(), Some(3));
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn answers_a_command_that_isnt_there_as_unstarted() {
        bazhen_test_signal::require_sandbox().unwrap();
        let run = ran(
            Command::new("/nonexistent/bazhen-no-such-command"),
            Duration::from_secs(10),
        );
        assert!(
            matches!(&run, Ended::Unstarted(e) if e.kind() == ErrorKind::NotFound),
            "{run:?}"
        );
    }

    /// Its output closed, the run is past reading and waits for its leader; a grandchild in its
    /// group, which a kill of the leader alone would leave running, ends with the group.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn kills_the_whole_group_of_a_run_that_outlives_its_time() {
        bazhen_test_signal::require_sandbox().unwrap();
        let file = pid_file("outlives");
        let script = format!(
            "sleep 30 >/dev/null 2>&1 & echo $! > '{}'; exec >&- 2>&-; wait",
            file.display()
        );
        let run = ran(sh(&script), Duration::from_secs(2));
        assert!(matches!(run, Ended::TimedOut), "{run:?}");
        assert!(ends_soon(pid_in(&file)));
    }

    /// The leader exits at once, but a member of its group holds the output open: the run is
    /// still bounded, and the member still ends with its group.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn kills_a_member_that_holds_the_output_after_its_leader_exits() {
        bazhen_test_signal::require_sandbox().unwrap();
        let file = pid_file("holds");
        let script = format!("sleep 30 & echo $! > '{}'", file.display());
        let run = ran(sh(&script), Duration::from_secs(2));
        assert!(matches!(run, Ended::TimedOut), "{run:?}");
        assert!(ends_soon(pid_in(&file)));
    }

    /// A run given up on, as a handler's future dropped when its client goes, still ends its
    /// group.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn kills_the_group_of_a_run_given_up_on() {
        bazhen_test_signal::require_sandbox().unwrap();
        let file = pid_file("dropped");
        let script = format!(
            "sleep 30 >/dev/null 2>&1 & echo $! > '{}'; exec >&- 2>&-; wait",
            file.display()
        );
        block_on(async {
            let run = run_bounded(sh(&script), Duration::from_secs(600));
            assert!(
                tokio::time::timeout(Duration::from_secs(2), run)
                    .await
                    .is_err()
            );
        });
        assert!(ends_soon(pid_in(&file)));
    }

    /// Reaped by something other than its `Child`, which still names its pid, the leader's pid is
    /// free: the kernel is asked, not the `Child`.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn sends_nothing_to_a_group_whose_leader_something_else_reaped() {
        bazhen_test_signal::require_sandbox().unwrap();
        block_on(async {
            let group = OwnGroup::spawn(&mut Command::new("true")).unwrap();
            rustix::process::waitpid(Some(group.leader), WaitOptions::empty()).unwrap();
            assert!(group.child.id().is_some());
            assert_eq!(
                group.signal(Signal::KILL),
                Err(Error::Unsafe {
                    target: Target {
                        leader: group.leader
                    },
                    why: Unsafe::Reaped,
                })
            );
        });
    }

    /// Reaped, the leader's pid is free, and the group's number can become another's.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn sends_nothing_to_a_group_whose_leader_has_been_reaped() {
        bazhen_test_signal::require_sandbox().unwrap();
        block_on(async {
            let mut group = OwnGroup::spawn(&mut Command::new("true")).unwrap();
            group.child.wait().await.unwrap();
            assert_eq!(
                group.signal(Signal::KILL),
                Err(Error::Unsafe {
                    target: Target {
                        leader: group.leader
                    },
                    why: Unsafe::Reaped,
                })
            );
        });
    }
}

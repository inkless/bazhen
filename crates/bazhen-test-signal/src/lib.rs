//! The one way Bazhen's Rust tests send a signal. A test's pid can be stale, read back from a
//! file, or the product of a mutant, and one that names init, the test, what ran it or the
//! test's own group ends work the test never started. So every target is checked here first,
//! and nothing else in a test may call `kill` (scripts/signal-paths.ts).

use rustix::process::{Pid, Signal, getpgid, getpgrp, getpid, getppid};

/// Why a signal wasn't sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    #[error("{0} is not a pid")]
    NotAPid(i64),
    #[error("{0} is init, or no single process")]
    NotSingle(i64),
    #[error("{0} is this test")]
    This(i64),
    #[error("{0} is what runs this test")]
    Parent(i64),
    #[error("{0} is this test's own process group")]
    OwnGroup(i64),
    #[error("{0} leads no process group")]
    NotAGroup(i64),
    #[error("signalling {0}: {1}")]
    Failed(i64, rustix::io::Errno),
}

/// The test process, as a target is checked against: its pid, its parent's, and its group.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Tester {
    pub pid: i32,
    pub parent: Option<i32>,
    pub group: i32,
}

impl Tester {
    /// This process.
    pub fn this() -> Self {
        Self {
            pid: getpid().as_raw_nonzero().get(),
            parent: getppid().map(|p| p.as_raw_nonzero().get()),
            group: getpgrp().as_raw_nonzero().get(),
        }
    }

    /// `target` as a pid this test may signal, or why it may not.
    ///
    /// # Errors
    ///
    /// When `target` isn't a pid above 1, or is this test, its parent or its own group.
    pub fn check(&self, target: i64) -> Result<Pid, Refused> {
        let raw = raw_pid(target).ok_or(Refused::NotAPid(target))?;
        if raw <= 1 {
            return Err(Refused::NotSingle(target));
        }
        if raw == self.pid {
            return Err(Refused::This(target));
        }
        if Some(raw) == self.parent {
            return Err(Refused::Parent(target));
        }
        if raw == self.group {
            return Err(Refused::OwnGroup(target));
        }
        Pid::from_raw(raw).ok_or(Refused::NotSingle(target))
    }
}

/// `target` as a `pid_t`, if it is one: never truncated, which would name another process.
fn raw_pid(target: i64) -> Option<i32> {
    i32::try_from(target).ok()
}

/// Sends `signal` to `pid` alone: a process the test started, or one it checked is still the
/// one it started.
///
/// # Errors
///
/// When the target is refused (`Tester::check`), or the system refuses the signal.
pub fn signal(pid: impl Into<i64>, signal: Signal) -> Result<(), Refused> {
    let target = pid.into();
    let pid = Tester::this().check(target)?;
    rustix::process::kill_process(pid, signal).map_err(|e| Refused::Failed(target, e))
}

/// Sends `signal` to the whole group `leader` leads: a child the test started in a group of its
/// own.
///
/// # Errors
///
/// When the target is refused (`Tester::check`), leads no group, or the system refuses.
pub fn signal_group(leader: impl Into<i64>, signal: Signal) -> Result<(), Refused> {
    let target = leader.into();
    let pid = Tester::this().check(target)?;
    if getpgid(Some(pid)).ok() != Some(pid) {
        return Err(Refused::NotAGroup(target));
    }
    rustix::process::kill_process_group(pid, signal).map_err(|e| Refused::Failed(target, e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt as _;
    use std::process::{Command, Stdio};

    const TESTER: Tester = Tester {
        pid: 5000,
        parent: Some(4000),
        group: 3000,
    };

    #[test]
    fn refuses_init_and_what_is_no_single_process() {
        for target in [0, 1, -1, -4242, i64::from(i32::MIN)] {
            assert_eq!(TESTER.check(target), Err(Refused::NotSingle(target)));
        }
    }

    #[test]
    fn refuses_what_no_pid_can_be() {
        // (1 << 32) + 4242 truncates to 4242, a live process somewhere.
        for target in [
            i64::from(i32::MAX) + 1,
            (1 << 32) + 4242,
            i64::MAX,
            i64::MIN,
        ] {
            assert_eq!(TESTER.check(target), Err(Refused::NotAPid(target)));
        }
    }

    #[test]
    fn refuses_the_test_what_runs_it_and_its_own_group() {
        assert_eq!(TESTER.check(5000), Err(Refused::This(5000)));
        assert_eq!(TESTER.check(4000), Err(Refused::Parent(4000)));
        assert_eq!(TESTER.check(3000), Err(Refused::OwnGroup(3000)));
    }

    #[test]
    fn allows_any_other_process() {
        for target in [2, 2999, 4001, 5001, i64::from(i32::MAX)] {
            assert_eq!(
                TESTER
                    .check(target)
                    .map(|p| p.as_raw_nonzero().get().into()),
                Ok(target)
            );
        }
    }

    #[test]
    fn has_no_parent_to_refuse_once_orphaned() {
        let orphan = Tester {
            parent: None,
            ..TESTER
        };
        assert!(orphan.check(4000).is_ok());
    }

    // Each sends SIGCONT, which changes nothing for a running process, so a check that let it
    // through would still harm nothing.
    #[test]
    fn refuses_this_test_and_its_parent_and_group_before_sending() {
        let this = Tester::this();
        assert_eq!(
            signal(this.pid, Signal::CONT),
            Err(Refused::This(this.pid.into()))
        );
        let parent = this.parent.unwrap();
        assert_eq!(
            signal(parent, Signal::CONT),
            Err(Refused::Parent(parent.into()))
        );
        // nextest starts each test as the leader of a group of its own, so the group is the test.
        let group = signal_group(this.group, Signal::CONT);
        assert!(
            matches!(group, Err(Refused::This(_) | Refused::OwnGroup(_))),
            "{group:?}"
        );
    }

    #[test]
    fn signals_a_child_and_the_group_it_leads() {
        let mut leader = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let pid = leader.id();
        assert_eq!(signal(pid, Signal::CONT), Ok(()));
        assert_eq!(signal_group(pid, Signal::KILL), Ok(()));
        assert!(!leader.wait().unwrap().success());
    }

    #[test]
    fn refuses_a_group_for_a_child_that_leads_none() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        assert_eq!(
            signal_group(pid, Signal::CONT),
            Err(Refused::NotAGroup(pid.into()))
        );
        assert_eq!(signal(pid, Signal::KILL), Ok(()));
        assert!(!child.wait().unwrap().success());
    }
}

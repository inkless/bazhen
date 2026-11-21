//! The one place Bazhen's Rust, outside the holder and the tests, sends a signal
//! (docs/standards/rust.md § Signals).
//!
//! Every send is checked here again, by its own reads, whatever its caller has checked: nothing
//! goes to init, whose group is every process, to this process, to any process it descends from,
//! or to its own group, and nothing goes to any group while this process can't read which group is
//! its own or which processes it descends from. A process group is reached only while this process
//! holds its leader unreaped (`group`), so the group's number can't since have become another's.

mod group;

use std::fmt;

use rustix::io::Errno;
use rustix::process::{Pid, Signal};

pub use group::{Ended, run_bounded};

/// What a signal was meant for: the process group a leader leads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Target {
    leader: Pid,
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "group {}", self.leader.as_raw_pid())
    }
}

/// Why a target is one no signal from here may reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Unsafe {
    #[error("it is init's, which names every process")]
    Init,
    #[error("it is this process's")]
    This,
    #[error("it is a process this one descends from")]
    Ancestor,
    #[error("it is this process's own group")]
    OwnGroup,
    #[error("this process's own group is unknown")]
    OwnGroupUnknown,
    #[error("the processes this one descends from can't all be read")]
    AncestryUnread,
    #[error("its leader has been reaped, so its number may be another group's")]
    Reaped,
}

/// Why nothing was sent: the target was refused, which is a fault and never a target that has
/// gone, or the system refused the send.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Error {
    #[error("refusing to signal {target}: {why}")]
    Unsafe { target: Target, why: Unsafe },
    #[error("signalling {target}: {source}")]
    Os { target: Target, source: Errno },
}

/// This process, as a target is checked against: its pid, every process it descends from
/// (`None` when they can't all be read), and its own group (`None` when it is led from outside
/// this PID namespace).
#[derive(Debug, Clone, PartialEq, Eq)]
struct Own {
    pid: Pid,
    ancestors: Option<Vec<Pid>>,
    group: Option<Pid>,
}

impl Own {
    fn read() -> Self {
        let pid = rustix::process::getpid();
        Self {
            pid,
            ancestors: bazhen_peer::ancestors(pid, bazhen_holder::process::parent).ok(),
            group: bazhen_pid::own_group(),
        }
    }
}

/// Why the group `leader` leads may not be signalled by `own`, if it may not.
fn floor(leader: Pid, own: &Own) -> Result<(), Unsafe> {
    if leader.is_init() {
        return Err(Unsafe::Init);
    }
    if leader == own.pid {
        return Err(Unsafe::This);
    }
    let Some(ancestors) = &own.ancestors else {
        return Err(Unsafe::AncestryUnread);
    };
    if ancestors.contains(&leader) {
        return Err(Unsafe::Ancestor);
    }
    match own.group {
        None => Err(Unsafe::OwnGroupUnknown),
        Some(group) if group == leader => Err(Unsafe::OwnGroup),
        Some(_) => Ok(()),
    }
}

/// Sends `signal` to the group `leader` leads, once the floor passes it. Whether the group was
/// still there.
fn send(leader: Pid, signal: Signal) -> Result<bool, Error> {
    let target = Target { leader };
    floor(leader, &Own::read()).map_err(|why| Error::Unsafe { target, why })?;
    match rustix::process::kill_process_group(leader, signal) {
        Ok(()) => Ok(true),
        Err(Errno::SRCH) => Ok(false),
        Err(source) => Err(Error::Os { target, source }),
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command;

    use rustix::process::{Pid, Signal, getpgrp, getpid, getppid};

    use super::{Error, Own, Target, Unsafe, floor, send};

    fn pid(raw: i32) -> Pid {
        Pid::from_raw(raw).unwrap()
    }

    /// This process as 500, descended from 400, 300 and init, in group 200.
    fn own() -> Own {
        Own {
            pid: pid(500),
            ancestors: Some(vec![pid(400), pid(300), pid(1)]),
            group: Some(pid(200)),
        }
    }

    #[test]
    fn refuses_init_whose_group_is_every_process() {
        assert_eq!(floor(pid(1), &own()), Err(Unsafe::Init));
    }

    #[test]
    fn refuses_this_process_and_its_own_group() {
        assert_eq!(floor(pid(500), &own()), Err(Unsafe::This));
        assert_eq!(floor(pid(200), &own()), Err(Unsafe::OwnGroup));
    }

    /// TypeScript's floor refuses only the parent. A grandparent's group is as much the work that
    /// started this process, so the walk goes all the way up.
    #[test]
    fn refuses_every_process_this_one_descends_from_not_only_its_parent() {
        assert_eq!(floor(pid(400), &own()), Err(Unsafe::Ancestor));
        assert_eq!(floor(pid(300), &own()), Err(Unsafe::Ancestor));
    }

    #[test]
    fn refuses_every_group_while_the_ancestry_or_own_group_is_unknown() {
        let unread = Own {
            ancestors: None,
            ..own()
        };
        let ungrouped = Own {
            group: None,
            ..own()
        };
        for leader in [2, 201, 401, 600] {
            assert_eq!(floor(pid(leader), &unread), Err(Unsafe::AncestryUnread));
            assert_eq!(floor(pid(leader), &ungrouped), Err(Unsafe::OwnGroupUnknown));
        }
    }

    #[test]
    fn passes_any_other_group() {
        for leader in [2, 199, 201, 301, 401, 501, i32::MAX] {
            assert_eq!(floor(pid(leader), &own()), Ok(()), "{leader}");
        }
    }

    /// `raw`'s parent as `ps` reads it, apart from the walk under test.
    fn parent_by_ps(raw: i32) -> Option<i32> {
        let out = Command::new("ps")
            .args(["-o", "ppid=", "-p", &raw.to_string()])
            .output()
            .ok()?;
        String::from_utf8(out.stdout).ok()?.trim().parse().ok()
    }

    #[test]
    fn reads_this_process_its_whole_ancestry_and_its_group() {
        let read = Own::read();
        assert_eq!(read.pid, getpid());
        assert_eq!(read.group, Some(getpgrp()));
        let ancestors = read.ancestors.unwrap();
        let mut next = getppid().map(Pid::as_raw_pid);
        let mut by_ps = Vec::new();
        while let Some(raw) = next.filter(|raw| *raw > 0) {
            by_ps.push(pid(raw));
            next = parent_by_ps(raw).filter(|_| raw > 1);
        }
        assert_eq!(ancestors, by_ps);
        // Past the parent, so a walk that stops there is caught.
        assert!(ancestors.len() >= 2, "{ancestors:?}");
    }

    /// Each target would harm nothing if the floor let it through: SIGCONT changes nothing for a
    /// running process.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn sends_nothing_to_this_process_its_parent_or_its_group() {
        bazhen_test_signal::require_sandbox().unwrap();
        let this = getpid();
        let mut refused = vec![(this, Unsafe::This)];
        if let Some(parent) = getppid().filter(|p| !p.is_init() && *p != getpgrp()) {
            refused.push((parent, Unsafe::Ancestor));
        }
        if getpgrp() != this {
            refused.push((getpgrp(), Unsafe::OwnGroup));
        }
        for (leader, why) in refused {
            assert_eq!(
                send(leader, Signal::CONT),
                Err(Error::Unsafe {
                    target: Target { leader },
                    why
                })
            );
        }
    }
}

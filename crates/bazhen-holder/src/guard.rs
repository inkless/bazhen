//! The one place the holder sends a signal.
//!
//! Each call is checked here again, by its own reads, whatever its caller has already checked, so
//! that no single wrong check elsewhere reaches a process that isn't the terminal's. Nothing is
//! sent to a number that names a group or every process (0, 1 and anything negative), to the
//! holder, its group, its session or any process it descends from, or to a process that isn't
//! proven the holder's own unreaped child or a member of the session such a child leads.

use std::io;

use rustix::io::Errno;
use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, getpid, getppid, waitid};

/// How far up its parents the holder looks for a process it descends from.
const MAX_ANCESTORS: usize = 1024;

/// Why the guard sent nothing.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Refused {
    #[error("{0} names a group of processes or every process, not one")]
    NotOne(i32),
    #[error("{0} is the holder, its group or its session")]
    Holder(i32),
    #[error("{0} is a process the holder descends from")]
    Ancestor(i32),
    #[error("{0} is not a child of the holder's, unreaped")]
    NotPinned(i32),
    #[error("{pid} is not in the session {leader} leads")]
    Outside { pid: i32, leader: i32 },
    /// A test build off a disposable host (the `sandbox-tripwire` feature).
    #[error("this test build is off a disposable host, so it sends no signal")]
    Unsandboxed,
}

/// Why a signal wasn't sent: the guard refused it, or the system did.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub(crate) enum SendError {
    #[error(transparent)]
    Refused(#[from] Refused),
    #[error(transparent)]
    Os(#[from] Errno),
}

/// Refuses a number that can't be signalled as one process of a terminal's.
pub(crate) fn vet(raw: i32) -> Result<(), Refused> {
    if raw <= 1 {
        return Err(Refused::NotOne(raw));
    }
    if names_the_holder(
        raw,
        getpid(),
        bazhen_pid::own_group(),
        bazhen_pid::session(None),
    ) {
        return Err(Refused::Holder(raw));
    }
    if is_ancestor(raw) {
        return Err(Refused::Ancestor(raw));
    }
    Ok(())
}

/// Whether `raw` numbers the holder, `own`, or its group or its session as `group` and `session`
/// read them. A group or session led from outside this PID namespace, which no number here names,
/// leaves the others to refuse, and so does a session that can't be read; the session's own check
/// on a member, which refuses whatever it can't read, still stands. The group is always read.
fn names_the_holder(
    raw: i32,
    own: Pid,
    group: Option<Pid>,
    session: io::Result<Option<Pid>>,
) -> bool {
    [Some(own), group, session.ok().flatten()]
        .into_iter()
        .flatten()
        .any(|pid| pid.as_raw_pid() == raw)
}

/// Refuses a session leader that isn't the holder's own child, unreaped. Only such a child's pid,
/// which is its group's and its session's, can't be given to another process.
pub(crate) fn vet_leader(leader: Pid) -> Result<(), Refused> {
    let raw = leader.as_raw_pid();
    vet(raw)?;
    loop {
        match waitid(
            WaitId::Pid(leader),
            WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
        ) {
            Ok(_) => return Ok(()),
            Err(Errno::INTR) => {}
            Err(_) => return Err(Refused::NotPinned(raw)),
        }
    }
}

/// Refuses `pid` unless it is in the session `leader` leads, and `leader` is pinned.
pub(crate) fn vet_member(pid: Pid, leader: Pid) -> Result<(), Refused> {
    vet(pid.as_raw_pid())?;
    vet_leader(leader)?;
    if proves_member(&bazhen_pid::session(Some(pid)), leader) {
        Ok(())
    } else {
        Err(Refused::Outside {
            pid: pid.as_raw_pid(),
            leader: leader.as_raw_pid(),
        })
    }
}

/// Whether a process's session, as `session` reads it, is the one `leader` leads. One that can't be
/// read, the process gone or not ours to ask about, is no proof, and nor is one led from outside
/// this PID namespace, which `leader`, the holder's own child, can't be.
fn proves_member(session: &io::Result<Option<Pid>>, leader: Pid) -> bool {
    matches!(session, Ok(Some(led)) if *led == leader)
}

/// Sends `signal` to the group `leader` leads, the holder's own child.
pub(crate) fn signal_group(leader: Pid, signal: Signal) -> Result<(), SendError> {
    vet_leader(leader)?;
    #[cfg(feature = "sandbox-tripwire")]
    tripwire()?;
    rustix::process::kill_process_group(leader, signal)?;
    Ok(())
}

/// Holds `pid` by a pidfd, proves the process it holds a member of the session `leader` leads,
/// then sends `signal` to it. Should `pid` have been given to another process before the proof,
/// the proof reads the other, and the signal still goes to the one held, which no longer takes it.
#[cfg(target_os = "linux")]
pub(crate) fn signal_member(pid: Pid, leader: Pid, signal: Signal) -> Result<(), SendError> {
    let held = rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty())?;
    vet_member(pid, leader)?;
    #[cfg(feature = "sandbox-tripwire")]
    tripwire()?;
    rustix::process::pidfd_send_signal(&held, signal)?;
    Ok(())
}

/// Watches `pid` for its exit, proves it a member of the session `leader` leads, and sends
/// `signal` to it unless the watch saw it exit. macOS can't hold a process: what is left is the
/// process exiting **and** its pid being given to another, both in the microseconds between the
/// last look at the watch and `kill(2)`. XNU hands pids out in increasing order up to 99 999,
/// skipping any in use as a pid, group or session, so the number would have to come round again
/// inside that window.
#[cfg(target_os = "macos")]
pub(crate) fn signal_member(pid: Pid, leader: Pid, signal: Signal) -> Result<(), SendError> {
    let watch = crate::macos::ExitWatch::new(pid)?;
    vet_member(pid, leader)?;
    #[cfg(feature = "sandbox-tripwire")]
    tripwire()?;
    if watch.exited()? {
        return Err(SendError::Os(Errno::SRCH));
    }
    rustix::process::kill_process(pid, signal)?;
    Ok(())
}

/// The marker a disposable host carries, as `bazhen_test_signal::require_sandbox` reads it: that
/// crate signals whatever a test names, so the holder can't depend on it, and a test holds the two
/// to one rule.
pub(crate) const DISPOSABLE_HOST_MARKER: &str = "/etc/bazhen-disposable-host";

/// Refuses a send off a disposable host, in a test build: the last check before every send. The
/// host qualifies by the marker, a plain file, not a link, that root owns.
#[cfg(feature = "sandbox-tripwire")]
pub(crate) fn tripwire() -> Result<(), Refused> {
    tripwire_at(std::path::Path::new(DISPOSABLE_HOST_MARKER))
}

/// `tripwire`, with the marker at `marker`.
pub(crate) fn tripwire_at(marker: &std::path::Path) -> Result<(), Refused> {
    use std::os::unix::fs::MetadataExt as _;

    match std::fs::symlink_metadata(marker) {
        Ok(found) if found.is_file() && found.uid() == 0 => Ok(()),
        _ => Err(Refused::Unsandboxed),
    }
}

/// Whether `raw` is the holder's parent, or its parent's, and so on up. A parent that can't be
/// read ends the walk: every ancestor is outside every session the holder starts, since a process
/// can join no session but its own new one, so this only backs up the session's check.
fn is_ancestor(raw: i32) -> bool {
    let mut next = getppid();
    for _ in 0..MAX_ANCESTORS {
        match next {
            Some(pid) if pid.as_raw_pid() == raw => return true,
            Some(pid) if !pid.is_init() => next = parent(pid),
            _ => return false,
        }
    }
    true
}

#[cfg(target_os = "linux")]
fn parent(pid: Pid) -> Option<Pid> {
    let stat = std::fs::read(format!("/proc/{}/stat", pid.as_raw_pid())).ok()?;
    Pid::from_raw(crate::start_time::parent_field(&stat)?)
}

#[cfg(target_os = "macos")]
fn parent(pid: Pid) -> Option<Pid> {
    crate::macos::parent(pid)
}

#[cfg(test)]
mod tests {
    use std::io::{BufRead as _, BufReader, Read as _};
    use std::process::{Command, Stdio};

    #[cfg(target_os = "macos")]
    use super::Errno;
    use rustix::process::{getpgrp, getsid};

    use super::{
        DISPOSABLE_HOST_MARKER, Pid, Refused, SendError, Signal, getpid, getppid, io,
        names_the_holder, proves_member, signal_group, signal_member, tripwire, tripwire_at, vet,
        vet_leader, vet_member,
    };

    #[test]
    fn the_tripwire_passes_only_a_plain_file_root_owns() {
        assert_eq!(
            tripwire_at(std::path::Path::new("/nonexistent/bazhen-disposable-host")),
            Err(Refused::Unsandboxed)
        );
        assert_eq!(
            tripwire_at(std::path::Path::new("/etc")),
            Err(Refused::Unsandboxed)
        );
        assert_eq!(tripwire_at(std::path::Path::new("/etc/passwd")), Ok(()));
    }

    #[test]
    fn every_test_build_sends_only_where_the_test_crate_would() {
        assert_eq!(
            DISPOSABLE_HOST_MARKER,
            bazhen_test_signal::DISPOSABLE_HOST_MARKER
        );
        assert_eq!(
            tripwire().is_ok(),
            bazhen_test_signal::require_sandbox().is_ok()
        );
    }

    /// Each test runs in a process of its own, so no other child of this one can take the reaped
    /// pid, and XNU hands pids out in increasing order, so no other process takes it this soon.
    #[cfg(target_os = "macos")]
    #[test]
    fn an_exit_watch_sees_its_process_exit_and_refuses_one_already_reaped() {
        use crate::macos::ExitWatch;

        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let pid = Pid::from_child(&child);
        let watch = ExitWatch::new(pid).unwrap();
        let before = watch.exited().unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(!before);
        assert!(watch.exited().unwrap());
        assert_eq!(ExitWatch::new(pid).err(), Some(Errno::SRCH));
    }

    #[test]
    fn no_number_that_names_a_group_or_every_process_is_one() {
        for raw in [0, 1, -1, -2, i32::MIN] {
            assert_eq!(vet(raw), Err(Refused::NotOne(raw)));
        }
    }

    #[test]
    fn the_holder_its_group_and_its_session_are_refused() {
        for pid in [getpid(), getpgrp(), getsid(None).unwrap()] {
            let raw = pid.as_raw_pid();
            if raw > 1 {
                assert_eq!(vet(raw), Err(Refused::Holder(raw)));
            }
        }
    }

    /// `pid` as the guard reads a session that it names, or one that can't be read.
    fn read_or_unreadable(pid: Option<Pid>) -> io::Result<Option<Pid>> {
        pid.map(Some)
            .ok_or_else(|| io::Error::other("can't be read"))
    }

    /// A session led from outside this PID namespace leaves `vet` refusing every number it refuses
    /// when the session can't be read: never fewer, so never more permissive. The holder's group,
    /// which is always read, is refused whatever the session reads.
    #[test]
    fn a_group_or_session_led_from_outside_refuses_what_an_unreadable_one_does() {
        let own = Pid::from_raw(100).unwrap();
        let (group, session) = (Pid::from_raw(200), Pid::from_raw(300));
        for raw in [2, 100, 200, 300, 400] {
            for read_group in [group, None] {
                for read_session in [session, None] {
                    let outside = names_the_holder(raw, own, read_group, Ok(read_session));
                    let unreadable =
                        names_the_holder(raw, own, read_group, read_or_unreadable(read_session));
                    assert_eq!(
                        outside, unreadable,
                        "{raw} with group {read_group:?}, session {read_session:?}"
                    );
                }
            }
        }
        for read_session in [Ok(session), Ok(None), read_or_unreadable(None)] {
            assert!(names_the_holder(200, own, group, read_session));
        }
        assert!(names_the_holder(100, own, None, Ok(None)));
        assert!(names_the_holder(300, own, None, Ok(session)));
        assert!(!names_the_holder(400, own, group, Ok(session)));
    }

    #[test]
    fn a_session_led_from_outside_or_unreadable_proves_no_member() {
        let leader = Pid::from_raw(100).unwrap();
        assert!(proves_member(&Ok(Some(leader)), leader));
        assert!(!proves_member(&Ok(None), leader));
        assert!(!proves_member(&read_or_unreadable(None), leader));
        assert!(!proves_member(&Ok(Pid::from_raw(101)), leader));
    }

    /// `pid`'s parent as `ps` reads it, apart from the guard's own reading, which is under test.
    fn parent_by_ps(pid: i32) -> Option<i32> {
        let out = Command::new("ps")
            .args(["-o", "ppid=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        String::from_utf8(out.stdout).ok()?.trim().parse().ok()
    }

    #[test]
    fn every_process_the_holder_descends_from_is_refused() {
        let own = [getpid(), getpgrp(), getsid(None).unwrap()].map(Pid::as_raw_pid);
        let mut next = getppid().map(Pid::as_raw_pid);
        let mut seen = 0;
        while let Some(raw) = next.filter(|raw| *raw > 1) {
            if !own.contains(&raw) {
                assert_eq!(vet(raw), Err(Refused::Ancestor(raw)));
                seen += 1;
            }
            next = parent_by_ps(raw);
        }
        // Past the parent, so a walk that stops there or skips a link is caught.
        assert!(seen >= 2, "only {seen} ancestor(s) to try");
    }

    #[test]
    fn a_child_of_the_holders_is_neither_the_holder_nor_an_ancestor() {
        let mut child = Command::new("sleep").arg("5").spawn().unwrap();
        let checked = vet(Pid::from_child(&child).as_raw_pid());
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(checked, Ok(()));
    }

    #[test]
    fn the_holders_own_live_child_is_a_leader_it_may_signal() {
        let mut child = Command::new("sleep").arg("5").spawn().unwrap();
        let pinned = vet_leader(Pid::from_child(&child));
        child.kill().unwrap();
        child.wait().unwrap();
        assert_eq!(pinned, Ok(()));
    }

    /// A live process that is no child of the holder's, though one of its descendants: only the
    /// wait proves a leader the holder's own, so any check that a process merely exists lets it by.
    #[test]
    fn a_leader_that_is_not_the_holders_child_is_refused() {
        let mut child = Command::new("sh")
            .args(["-c", "sleep 2 & echo $!; wait"])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let grandchild = Pid::from_raw(line.trim().parse().unwrap()).unwrap();
        let pinned = vet_leader(grandchild);
        let sent = signal_group(grandchild, Signal::CONT);
        let alive = rustix::process::test_kill_process(grandchild);
        child.wait().unwrap();
        assert!(alive.is_ok(), "the grandchild had exited: {alive:?}");
        let refused = Refused::NotPinned(grandchild.as_raw_pid());
        assert_eq!(pinned, Err(refused));
        assert_eq!(sent, Err(SendError::Refused(refused)));
    }

    #[test]
    fn a_process_outside_the_leaders_session_is_refused() {
        let mut leader = Command::new("sleep").arg("5").spawn().unwrap();
        let mut other = Command::new("sleep").arg("5").spawn().unwrap();
        let (leader_pid, other_pid) = (Pid::from_child(&leader), Pid::from_child(&other));
        let checked = vet_member(other_pid, leader_pid);
        for child in [&mut leader, &mut other] {
            child.kill().unwrap();
            child.wait().unwrap();
        }
        assert_eq!(
            checked,
            Err(Refused::Outside {
                pid: other_pid.as_raw_pid(),
                leader: leader_pid.as_raw_pid(),
            })
        );
    }

    /// The sweep's own membership check passing a stranger, as a wrong edit of it would: the
    /// guard's check, made apart from it, still sends the stranger nothing.
    #[test]
    #[ignore = "signals processes; runs in make test-real ARGS=rust"]
    fn a_stranger_vouched_for_as_a_member_is_sent_nothing() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut leader = Command::new("sleep").arg("30").spawn().unwrap();
        let mut stranger = Command::new("sh")
            .args(["-c", "trap 'echo hup' HUP; echo armed; read _; echo done"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdout = BufReader::new(stranger.stdout.take().unwrap());
        let mut line = String::new();
        stdout.read_line(&mut line).unwrap();
        assert_eq!(line, "armed\n");
        let pid = Pid::from_child(&stranger);
        let sent = signal_member(pid, Pid::from_child(&leader), Signal::HUP);
        drop(stranger.stdin.take());
        let mut rest = String::new();
        stdout.read_to_string(&mut rest).unwrap();
        stranger.wait().unwrap();
        leader.kill().unwrap();
        leader.wait().unwrap();
        assert!(
            matches!(sent, Err(SendError::Refused(Refused::Outside { .. }))),
            "{sent:?}"
        );
        assert_eq!(rest, "done\n");
    }
}

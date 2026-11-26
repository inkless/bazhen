//! The one place Bazhen's Rust, outside the holder and the tests, sends a signal
//! (docs/standards/rust.md § Signals).
//!
//! Every send is checked here again, by its own reads, whatever its caller has checked: nothing
//! goes to init, whose group is every process, to this process, to any process it descends from,
//! or to its own group, and nothing goes to any group while this process can't read which group is
//! its own or which processes it descends from. A process group is reached only while this process
//! holds its leader unreaped (`group`), so the group's number can't since have become another's. A
//! single process is reached only as a `bazhen-holder` checked by its name and start time
//! (`holder`), checked again on Linux once a pidfd holds it and signalled through that pidfd, or
//! by signal 0, which sends nothing (`is_alive`). Holding a leader unreaped holds only while
//! SIGCHLD is neither ignored nor set with `SA_NOCLDWAIT`: either way the kernel reaps children
//! itself, and a group is then refused once its leader has exited. A daemon undoes both before it
//! starts a child (`keep_exited_children`), and keeps any handler already set.

mod group;
pub mod holder;
pub mod ptys;
pub mod scope;

use std::fmt;

use rustix::io::Errno;
use rustix::process::{Pid, RawPid, Signal};

pub use bazhen_pid::{children_kept, keep_exited_children};
pub use group::{Ended, OUTPUT_MAX, Ran, run_bounded, run_kept};

/// What a signal was meant for: the process group a leader leads, or one process.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Target {
    Group(Pid),
    Process(Pid),
}

impl fmt::Display for Target {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Group(leader) => write!(f, "group {}", leader.as_raw_pid()),
            Self::Process(pid) => write!(f, "process {}", pid.as_raw_pid()),
        }
    }
}

/// Why a target is one no signal from here may reach.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum Unsafe {
    #[error("it is init's or no process's, and kill reads each as many processes")]
    NotAboveInit,
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
    #[error("it was vouched for another signal")]
    Unvouched,
    #[error("it was vouched for more than a second ago, so its pid may be another process's")]
    Stale,
    #[error(
        "what has its pid now can't be read, so it can't be shown to be the process vouched for"
    )]
    Unshown,
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

/// Why `target`, a group's leader or a process, may not be signalled by `own`, if it may not.
/// Raw, since a `Pid` can hold a negative number, which `kill_process_group` would negate into a
/// process's own. A process numbered as this one's group is refused too: it leads that group.
fn floor(target: RawPid, own: &Own) -> Result<(), Unsafe> {
    if target <= 1 {
        return Err(Unsafe::NotAboveInit);
    }
    if target == own.pid.as_raw_pid() {
        return Err(Unsafe::This);
    }
    let Some(ancestors) = &own.ancestors else {
        return Err(Unsafe::AncestryUnread);
    };
    if ancestors.iter().any(|a| a.as_raw_pid() == target) {
        return Err(Unsafe::Ancestor);
    }
    match own.group {
        None => Err(Unsafe::OwnGroupUnknown),
        Some(group) if group.as_raw_pid() == target => Err(Unsafe::OwnGroup),
        Some(_) => Ok(()),
    }
}

/// Sends `signal` to the group `leader` leads, once the floor passes it. Whether the group was
/// still there.
fn send(leader: Pid, signal: Signal) -> Result<bool, Error> {
    let target = Target::Group(leader);
    floor(leader.as_raw_pid(), &Own::read()).map_err(|why| Error::Unsafe { target, why })?;
    sent(target, rustix::process::kill_process_group(leader, signal))
}

/// Sends `signal` to `pid` alone, once the floor passes it. Only `signal_child` calls it, with a
/// child held unreaped. Whether the process was still there.
fn send_process(pid: Pid, signal: Signal) -> Result<bool, Error> {
    let target = Target::Process(pid);
    floor(pid.as_raw_pid(), &Own::read()).map_err(|why| Error::Unsafe { target, why })?;
    sent(target, rustix::process::kill_process(pid, signal))
}

/// Sends `signal` to `pid` alone, once the floor passes it and only if `shows` holds of the
/// process that has `pid` once it is pinned: a holder, which `holder` checks by its name and
/// start time. On Linux a pidfd pins the process before `shows` reads it and the signal goes
/// through that pidfd, so a pid reused at any point reaches nothing but the process `shows` read
/// or one already gone. macOS has no such handle, so there `shows` and the send stay a moment
/// apart.
///
/// Whether it was sent: `false` for a process gone, or one `shows` says isn't the one meant.
fn send_pinned(
    pid: Pid,
    signal: Signal,
    shows: impl FnOnce() -> Result<bool, Unsafe>,
) -> Result<bool, Error> {
    let target = Target::Process(pid);
    floor(pid.as_raw_pid(), &Own::read()).map_err(|why| Error::Unsafe { target, why })?;
    pin_then_send(target, pid, signal, shows)
}

#[cfg(target_os = "linux")]
fn pin_then_send(
    target: Target,
    pid: Pid,
    signal: Signal,
    shows: impl FnOnce() -> Result<bool, Unsafe>,
) -> Result<bool, Error> {
    let pinned = match rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty()) {
        Ok(pinned) => pinned,
        Err(refused) => return unpinned(target, refused),
    };
    if !shows().map_err(|why| Error::Unsafe { target, why })? {
        return Ok(false);
    }
    sent(target, rustix::process::pidfd_send_signal(&pinned, signal))
}

/// What a refused pin says of its target. `INVAL` is a pid that now names a thread other than its
/// process's leader, as a holder's pid reused for another process's thread would: the holder is
/// gone, as with `SRCH`. Anything else, as no file descriptor left, is an error, since the target
/// may still run.
#[cfg(target_os = "linux")]
fn unpinned(target: Target, refused: Errno) -> Result<bool, Error> {
    match refused {
        Errno::SRCH | Errno::INVAL => Ok(false),
        source => Err(Error::Os { target, source }),
    }
}

#[cfg(target_os = "macos")]
fn pin_then_send(
    target: Target,
    pid: Pid,
    signal: Signal,
    shows: impl FnOnce() -> Result<bool, Unsafe>,
) -> Result<bool, Error> {
    if !shows().map_err(|why| Error::Unsafe { target, why })? {
        return Ok(false);
    }
    sent(target, rustix::process::kill_process(pid, signal))
}

/// What a send's answer says: whether its target was still there.
fn sent(target: Target, answer: Result<(), Errno>) -> Result<bool, Error> {
    match answer {
        Ok(()) => Ok(true),
        Err(Errno::SRCH) => Ok(false),
        Err(source) => Err(Error::Os { target, source }),
    }
}

/// Sends `signal` to `pid` alone, a child this process spawned, while the kernel holds it
/// unreaped, so its pid is still its own. Whether it was sent.
fn signal_child(pid: Pid, signal: Signal) -> Result<bool, Error> {
    if !group::unreaped(pid) {
        return Err(Error::Unsafe {
            target: Target::Process(pid),
            why: Unsafe::Reaped,
        });
    }
    send_process(pid, signal)
}

/// Whether a process has `pid`, by signal 0, which sends nothing, once the floor passes it. One
/// this user may not signal counts as alive, and so does one that has exited and isn't yet
/// reaped.
///
/// # Errors
///
/// When the floor refuses `pid`, as init, this process, one it descends from or its own group,
/// or the kernel answers anything but that.
pub fn is_alive(pid: Pid) -> Result<bool, Error> {
    let target = Target::Process(pid);
    floor(pid.as_raw_pid(), &Own::read()).map_err(|why| Error::Unsafe { target, why })?;
    alive(target, rustix::process::test_kill_process(pid))
}

/// What a probe's answer says of its target.
fn alive(target: Target, probed: Result<(), Errno>) -> Result<bool, Error> {
    match probed {
        Ok(()) | Err(Errno::PERM) => Ok(true),
        Err(Errno::SRCH) => Ok(false),
        Err(source) => Err(Error::Os { target, source }),
    }
}

#[cfg(test)]
mod tests {
    use std::os::unix::process::ExitStatusExt as _;
    use std::process::Command;

    use rustix::process::{Pid, Signal, getpgrp, getpid, getppid};

    use rustix::io::Errno;

    use super::{Error, Own, Target, Unsafe, alive, floor, is_alive, send, send_pinned};

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

    /// Kill reads 0 as this process's group, -1 as every process, and below that the group of
    /// the pid negated.
    #[test]
    fn refuses_init_and_every_number_kill_reads_as_many_processes() {
        for leader in [1, 0, -1, -2, -500, i32::MIN] {
            assert_eq!(floor(leader, &own()), Err(Unsafe::NotAboveInit), "{leader}");
        }
    }

    #[test]
    fn refuses_this_process_and_its_own_group() {
        assert_eq!(floor(500, &own()), Err(Unsafe::This));
        assert_eq!(floor(200, &own()), Err(Unsafe::OwnGroup));
    }

    /// TypeScript's floor refuses only the parent. A grandparent's group is as much the work that
    /// started this process, so the walk goes all the way up.
    #[test]
    fn refuses_every_process_this_one_descends_from_not_only_its_parent() {
        assert_eq!(floor(400, &own()), Err(Unsafe::Ancestor));
        assert_eq!(floor(300, &own()), Err(Unsafe::Ancestor));
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
            assert_eq!(floor(leader, &unread), Err(Unsafe::AncestryUnread));
            assert_eq!(floor(leader, &ungrouped), Err(Unsafe::OwnGroupUnknown));
        }
    }

    #[test]
    fn passes_any_other_group() {
        for leader in [2, 199, 201, 301, 401, 501, i32::MAX] {
            assert_eq!(floor(leader, &own()), Ok(()), "{leader}");
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
                    target: Target::Group(leader),
                    why
                })
            );
        }
    }

    /// The floor refuses first, so nothing is pinned or checked. SIGCONT changes nothing for a
    /// running process, so even a floor that let this process through would harm nothing.
    #[test]
    fn refuses_a_pinned_send_to_this_process_before_checking_it() {
        let checked = std::cell::Cell::new(false);
        let sent = send_pinned(getpid(), Signal::CONT, || {
            checked.set(true);
            Ok(true)
        });
        assert_eq!(
            (sent, checked.get()),
            (
                Err(Error::Unsafe {
                    target: Target::Process(getpid()),
                    why: Unsafe::This
                }),
                false
            )
        );
    }

    fn sleeping() -> (std::process::Child, Pid) {
        let child = Command::new("sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let raw = i32::try_from(child.id()).unwrap();
        (child, pid(raw))
    }

    /// How long a process sent SIGKILL takes, at most, to be seen ended.
    const ENDS: std::time::Duration = std::time::Duration::from_secs(5);
    /// How long a process sent nothing is watched for an end that would show it was sent one.
    const STILL: std::time::Duration = std::time::Duration::from_millis(500);

    /// A pid freed before the send is never checked, as it would be by a check made before the
    /// pin: whatever had it is gone, and nothing at it is read or sent.
    #[cfg(target_os = "linux")]
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn pins_a_process_before_checking_it() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut child = Command::new("true").spawn().unwrap();
        let raw = i32::try_from(child.id()).unwrap();
        child.wait().unwrap();
        let checked = std::cell::Cell::new(false);
        let sent = send_pinned(pid(raw), Signal::KILL, || {
            checked.set(true);
            Ok(false)
        });
        assert_eq!((sent, checked.get()), (Ok(false), false));
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn sends_nothing_to_a_pinned_process_not_shown_as_the_one_meant() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (mut child, at) = sleeping();
        let declined = send_pinned(at, Signal::KILL, || Ok(false));
        let refused = send_pinned(at, Signal::KILL, || Err(Unsafe::Unshown));
        let ended = bazhen_test_signal::end_within(&mut child, STILL).unwrap();
        assert_eq!(
            (declined, refused, ended.map(|e| e.signal())),
            (
                Ok(false),
                Err(Error::Unsafe {
                    target: Target::Process(at),
                    why: Unsafe::Unshown
                }),
                None
            )
        );
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn sends_to_a_pinned_process_shown_as_the_one_meant() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (mut child, at) = sleeping();
        let sent = send_pinned(at, Signal::KILL, || Ok(true));
        let ended = bazhen_test_signal::end_within(&mut child, ENDS).unwrap();
        assert_eq!(
            (sent, ended.map(|e| e.signal())),
            (Ok(true), Some(Some(Signal::KILL.as_raw())))
        );
    }

    /// Signal 0 sends nothing, and the floor refuses these before it would.
    #[test]
    fn asks_nothing_of_init_or_of_this_process() {
        for (target, why) in [(pid(1), Unsafe::NotAboveInit), (getpid(), Unsafe::This)] {
            assert_eq!(
                is_alive(target),
                Err(Error::Unsafe {
                    target: Target::Process(target),
                    why
                })
            );
        }
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn takes_a_pid_gone_or_now_another_process_s_thread_for_gone_and_fails_closed_otherwise() {
        let target = Target::Process(pid(4242));
        let answers = [
            Errno::SRCH,
            Errno::INVAL,
            Errno::MFILE,
            Errno::NOMEM,
            Errno::PERM,
        ]
        .map(|refused| super::unpinned(target, refused));
        let os = |source| Err(Error::Os { target, source });
        assert_eq!(
            answers,
            [
                Ok(false),
                Ok(false),
                os(Errno::MFILE),
                os(Errno::NOMEM),
                os(Errno::PERM)
            ]
        );
    }

    /// A process of another user's is there, though this one may not signal it.
    #[test]
    fn counts_a_process_it_may_not_signal_as_alive_and_none_as_gone() {
        let target = Target::Process(pid(4242));
        assert_eq!(alive(target, Ok(())), Ok(true));
        assert_eq!(alive(target, Err(Errno::PERM)), Ok(true));
        assert_eq!(alive(target, Err(Errno::SRCH)), Ok(false));
        assert_eq!(
            alive(target, Err(Errno::INVAL)),
            Err(Error::Os {
                target,
                source: Errno::INVAL
            })
        );
    }

    #[test]
    fn names_a_group_and_a_process_apart() {
        assert_eq!(Target::Group(pid(42)).to_string(), "group 42");
        assert_eq!(Target::Process(pid(42)).to_string(), "process 42");
    }

    /// Signal 0 sends nothing, but a child exited and unreaped still holds its pid, so it is
    /// still there.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn finds_a_child_alive_until_it_is_reaped() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut child = Command::new("true").spawn().unwrap();
        let raw = i32::try_from(child.id()).unwrap();
        let exited = std::time::Instant::now();
        while rustix::process::waitid(
            rustix::process::WaitId::Pid(pid(raw)),
            rustix::process::WaitIdOptions::EXITED
                | rustix::process::WaitIdOptions::NOHANG
                | rustix::process::WaitIdOptions::NOWAIT,
        )
        .unwrap()
        .is_none()
        {
            assert!(exited.elapsed().as_secs() < 10, "true never exited");
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert_eq!(is_alive(pid(raw)), Ok(true));
        child.wait().unwrap();
    }
}

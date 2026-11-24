//! The one place Bazhen's Rust, outside the holder and the tests, sends a signal
//! (docs/standards/rust.md § Signals).
//!
//! Every send is checked here again, by its own reads, whatever its caller has checked: nothing
//! goes to init, whose group is every process, to this process, to any process it descends from,
//! or to its own group, and nothing goes to any group while this process can't read which group is
//! its own or which processes it descends from. A process group is reached only while this process
//! holds its leader unreaped (`group`, `signal_group`), so the group's number can't since have
//! become another's. A single process is reached only as a `bazhen-holder` checked by its name and
//! start time (`holder`), checked again on Linux once a pidfd holds it and signalled through that
//! pidfd; as a child this process holds unreaped, spawned or adopted, which on Linux the kernel's
//! wait on a pidfd shows to be its child before the signal goes through that pidfd
//! (`signal_child`); or by signal 0, which sends nothing (`is_alive`). The one signal to this
//! process is the one it dies by (`die_by`).
//!
//! Holding a leader unreaped holds only while SIGCHLD is neither ignored nor set with
//! `SA_NOCLDWAIT`: either way the kernel reaps children itself, and a group is then refused once
//! its leader has exited. A daemon undoes both before it starts a child (`keep_exited_children`),
//! and keeps any handler already set.

mod group;
pub mod holder;
pub mod ptys;
pub mod scope;

use std::fmt;

use rustix::io::Errno;
use rustix::process::{Pid, RawPid, Signal, WaitId, WaitIdOptions};

pub use bazhen_pid::{children_kept, keep_exited_children};
pub use group::{Ended, run_bounded};

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
            ancestors: bazhen_pid::ancestors(pid, bazhen_pid::parent).ok(),
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

/// Sends `signal` to `pid` alone, once the floor passes it. Only `signal_child` calls it, on macOS,
/// with a child held unreaped. Whether the process was still there.
#[cfg(target_os = "macos")]
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

/// Whether the kernel holds `leader` as this process's child, running or exited, and not yet
/// reaped. Anything else, a leader reaped by something but its `Child` included, is no.
pub(crate) fn unreaped(leader: Pid) -> bool {
    let unreaped = WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT;
    rustix::process::waitid(WaitId::Pid(leader), unreaped).is_ok()
}

/// Sends `signal` to the group `leader` leads, a child this process spawned into a group of its
/// own, while the kernel holds the leader unreaped, so the group's number is still the leader's.
/// Whether the group was still there.
///
/// # Errors
///
/// `Reaped` for a leader the kernel holds as no unreaped child of this process's, and otherwise
/// when the floor refuses it or the kernel refuses the send.
pub fn signal_group(leader: Pid, signal: Signal) -> Result<bool, Error> {
    if !unreaped(leader) {
        return Err(Error::Unsafe {
            target: Target::Group(leader),
            why: Unsafe::Reaped,
        });
    }
    send(leader, signal)
}

/// Sends `signal` to `pid` alone, a child of this process's, spawned or adopted as a subreaper's
/// orphan, while the kernel holds it unreaped, so its pid is still its own. On Linux a pidfd holds
/// it first, the kernel's own wait on that pidfd shows it is this process's child, and the signal
/// goes through it, so `/proc` is never asked whose child it is. Whether it was sent: `false` for
/// a child that has exited, whose pid it still holds.
///
/// # Errors
///
/// `Reaped` for a pid the kernel holds as no unreaped child of this process's, and otherwise when
/// the floor refuses it or the kernel refuses the send.
pub fn signal_child(pid: Pid, signal: Signal) -> Result<bool, Error> {
    let target = Target::Process(pid);
    floor(pid.as_raw_pid(), &Own::read()).map_err(|why| Error::Unsafe { target, why })?;
    child_then_send(target, pid, signal)
}

#[cfg(target_os = "linux")]
fn child_then_send(target: Target, pid: Pid, signal: Signal) -> Result<bool, Error> {
    use std::os::fd::AsFd as _;

    let reaped = Error::Unsafe {
        target,
        why: Unsafe::Reaped,
    };
    let pinned = match rustix::process::pidfd_open(pid, rustix::process::PidfdFlags::empty()) {
        Ok(pinned) => pinned,
        Err(Errno::SRCH | Errno::INVAL) => return Err(reaped),
        Err(source) => return Err(Error::Os { target, source }),
    };
    let unreaped = WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT;
    match rustix::process::waitid(WaitId::PidFd(pinned.as_fd()), unreaped) {
        Ok(None) => sent(target, rustix::process::pidfd_send_signal(&pinned, signal)),
        Ok(Some(_)) => Ok(false),
        Err(Errno::CHILD) => Err(reaped),
        Err(source) => Err(Error::Os { target, source }),
    }
}

#[cfg(target_os = "macos")]
fn child_then_send(target: Target, pid: Pid, signal: Signal) -> Result<bool, Error> {
    if !unreaped(pid) {
        return Err(Error::Unsafe {
            target,
            why: Unsafe::Reaped,
        });
    }
    send_process(pid, signal)
}

/// Ends this process as `signal` ends one by its default action, so whatever waits for it sees it
/// die by that signal, as a wrapper that passes its command's death on must. The signal's action is
/// set back to its default and it is unblocked first, and before one whose default dumps core the
/// core limit goes to 0, so no core is left behind. A signal whose default doesn't end a process,
/// one ignored or one that stops it, isn't sent; nor is any signal once a step before it fails:
/// the process then exits 128 plus the signal's number, as a shell reports a death by it.
pub fn die_by(signal: Signal) -> ! {
    let raw = signal.as_raw();
    if ends_by_default(raw) && ready_to_die_by(raw) {
        // Nothing to do with an error: the exit below follows either way.
        let _ = rustix::process::kill_process(rustix::process::getpid(), signal);
    }
    std::process::exit(128_i32.saturating_add(raw))
}

/// Whether a signal's default action ends a process: all but those ignored, and those that stop
/// or continue one.
fn ends_by_default(raw: i32) -> bool {
    ![
        libc::SIGCHLD,
        libc::SIGCONT,
        libc::SIGSTOP,
        libc::SIGTSTP,
        libc::SIGTTIN,
        libc::SIGTTOU,
        libc::SIGURG,
        libc::SIGWINCH,
        #[cfg(target_os = "macos")]
        libc::SIGINFO,
    ]
    .contains(&raw)
}

/// Whether a signal's default action dumps core.
fn dumps_core(raw: i32) -> bool {
    [
        libc::SIGQUIT,
        libc::SIGILL,
        libc::SIGTRAP,
        libc::SIGABRT,
        libc::SIGBUS,
        libc::SIGFPE,
        libc::SIGSEGV,
        libc::SIGXCPU,
        libc::SIGXFSZ,
        libc::SIGSYS,
        #[cfg(target_os = "macos")]
        libc::SIGEMT,
    ]
    .contains(&raw)
}

/// Sets this process up to die by `raw`: no core, its default action, and unblocked. SIGKILL's
/// action can't be set and it can't be blocked, so it is ready as it is.
fn ready_to_die_by(raw: i32) -> bool {
    if raw == libc::SIGKILL {
        return true;
    }
    if dumps_core(raw) {
        use rustix::process::{Resource, Rlimit, getrlimit, setrlimit};
        let limit = getrlimit(Resource::Core);
        let none = Rlimit {
            current: Some(0),
            maximum: limit.maximum,
        };
        if setrlimit(Resource::Core, none).is_err() {
            return false;
        }
    }
    bazhen_pid::default_action(raw).is_ok() && bazhen_pid::unblock(raw).is_ok()
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
    use std::io::BufRead as _;
    use std::os::unix::process::{CommandExt as _, ExitStatusExt as _};
    use std::process::Command;

    use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, getpgrp, getpid, getppid};

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

    /// A child that runs `sleep 30` in a process group of its own.
    fn sleeping_group() -> (std::process::Child, Pid) {
        let child = Command::new("sleep")
            .arg("30")
            .stdin(std::process::Stdio::null())
            .process_group(0)
            .spawn()
            .unwrap();
        let raw = i32::try_from(child.id()).unwrap();
        (child, pid(raw))
    }

    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn signals_a_child_it_holds_unreaped_and_its_group() {
        bazhen_test_signal::require_sandbox().unwrap();
        let (mut child, at) = sleeping();
        let sent = super::signal_child(at, Signal::KILL);
        let ended = bazhen_test_signal::end_within(&mut child, ENDS).unwrap();
        let (mut led, leader) = sleeping_group();
        let group_sent = super::signal_group(leader, Signal::KILL);
        let group_ended = bazhen_test_signal::end_within(&mut led, ENDS).unwrap();
        assert_eq!(
            (
                sent,
                ended.map(|e| e.signal()),
                group_sent,
                group_ended.map(|e| e.signal())
            ),
            (
                Ok(true),
                Some(Some(Signal::KILL.as_raw())),
                Ok(true),
                Some(Some(Signal::KILL.as_raw()))
            )
        );
    }

    /// A child that has exited holds its pid until it is reaped, so a send to it reaches nothing
    /// and says so; once reaped, it is no child of this process's at all.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn sends_nothing_to_a_child_that_has_exited_and_refuses_one_reaped() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut child = Command::new("true").spawn().unwrap();
        let at = pid(i32::try_from(child.id()).unwrap());
        let unreaped = WaitIdOptions::EXITED | WaitIdOptions::NOWAIT;
        rustix::process::waitid(WaitId::Pid(at), unreaped).unwrap();
        let exited = super::signal_child(at, Signal::KILL);
        child.wait().unwrap();
        let reaped = super::signal_child(at, Signal::KILL);
        let group_reaped = super::signal_group(at, Signal::KILL);
        assert_eq!(
            (exited, reaped, group_reaped),
            (
                Ok(false),
                Err(Error::Unsafe {
                    target: Target::Process(at),
                    why: Unsafe::Reaped
                }),
                Err(Error::Unsafe {
                    target: Target::Group(at),
                    why: Unsafe::Reaped
                })
            )
        );
    }

    /// A grandchild runs, and its pid is held, but by its own parent: the kernel's wait shows it
    /// is no child of this process's, whatever its pid, so nothing is sent.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn sends_nothing_to_a_process_that_is_no_child_of_its_own() {
        bazhen_test_signal::require_sandbox().unwrap();
        let mut parent = Command::new("sh")
            .args(["-c", "sleep 30 & echo $!; wait"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .process_group(0)
            .spawn()
            .unwrap();
        let mut line = String::new();
        std::io::BufReader::new(parent.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let grandchild = pid(line.trim().parse().unwrap());
        let refused = super::signal_child(grandchild, Signal::KILL);
        let group_refused = super::signal_group(grandchild, Signal::KILL);
        let alive = is_alive(grandchild);
        bazhen_test_signal::signal_group(parent.id(), Signal::KILL).unwrap();
        parent.wait().unwrap();
        assert_eq!(
            (refused, group_refused, alive),
            (
                Err(Error::Unsafe {
                    target: Target::Process(grandchild),
                    why: Unsafe::Reaped
                }),
                Err(Error::Unsafe {
                    target: Target::Group(grandchild),
                    why: Unsafe::Reaped
                }),
                Ok(true)
            )
        );
    }

    /// The floor refuses first, so the kernel is never asked whose child it is.
    #[test]
    fn refuses_a_child_send_to_init_or_this_process() {
        for (target, why) in [(pid(1), Unsafe::NotAboveInit), (getpid(), Unsafe::This)] {
            assert_eq!(
                super::signal_child(target, Signal::CONT),
                Err(Error::Unsafe {
                    target: Target::Process(target),
                    why
                })
            );
        }
    }

    #[test]
    fn knows_which_signals_end_a_process_and_which_dump_core_by_default() {
        let ends = [
            libc::SIGTERM,
            libc::SIGKILL,
            libc::SIGSEGV,
            libc::SIGWINCH,
            libc::SIGTSTP,
            libc::SIGCHLD,
        ]
        .map(super::ends_by_default);
        let dumps =
            [libc::SIGSEGV, libc::SIGABRT, libc::SIGTERM, libc::SIGKILL].map(super::dumps_core);
        assert_eq!(
            (ends, dumps),
            (
                [true, true, true, false, false, false],
                [true, true, false, false]
            )
        );
    }

    /// Names the signal `dies_by_the_signal_it_is_given` has this test binary die by.
    const DIE_BY: &str = "BAZHEN_HOST_GUARD_TEST_DIE_BY";

    /// Run by `dies_by_the_signal_it_is_given`, in a process of its own, which it ends; run alone,
    /// it does nothing.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn die_by_the_signal_named() {
        bazhen_test_signal::require_sandbox().unwrap();
        let Some(raw) = std::env::var(DIE_BY).ok().and_then(|n| n.parse().ok()) else {
            return;
        };
        let signal = Signal::from_named_raw(raw).unwrap();
        super::die_by(signal);
    }

    /// A signal that ends a process ends it by that signal, with no core even for one whose
    /// default dumps one; any other, which would leave it running or stopped, exits it 128 + n.
    #[test]
    #[ignore = "signals processes; runs in moon run :test-real -- rust"]
    fn dies_by_the_signal_it_is_given() {
        bazhen_test_signal::require_sandbox().unwrap();
        let exe = std::env::current_exe().unwrap();
        let died = [
            libc::SIGTERM,
            libc::SIGSEGV,
            libc::SIGKILL,
            libc::SIGWINCH,
            libc::SIGTSTP,
        ]
        .map(|raw| {
            let status = Command::new(&exe)
                .args(["--exact", "tests::die_by_the_signal_named", "--ignored"])
                .env(DIE_BY, raw.to_string())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .status()
                .unwrap();
            (status.signal(), status.core_dumped(), status.code())
        });
        assert_eq!(
            died,
            [
                (Some(libc::SIGTERM), false, None),
                (Some(libc::SIGSEGV), false, None),
                (Some(libc::SIGKILL), false, None),
                (None, false, Some(128 + libc::SIGWINCH)),
                (None, false, Some(128 + libc::SIGTSTP)),
            ]
        );
    }
}

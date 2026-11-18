//! What the kernel says a process's session, group or socket peer is, read so that its answer is
//! never taken for a pid it isn't. A kernel answers 0 for a process, session or group with no pid
//! in the caller's PID namespace, as one outside a container the caller runs in has; rustix's
//! `getsid`, `getpgid`, `getpgrp` and `socket_peercred` build their non-zero `Pid` from that 0
//! unchecked, which is undefined behaviour, so these read the kernel through libc instead.

use std::io;
use std::os::fd::BorrowedFd;

use rustix::process::{Pid, RawPid};

mod sys;

/// `raw`, as the kernel answered it for `what`, when it is a pid this process can name.
///
/// # Errors
///
/// When `raw` isn't above 0.
pub(crate) fn visible(raw: RawPid, what: &str) -> io::Result<Pid> {
    // Tested before `Pid::from_raw`, which asserts `raw >= 0` in a debug build rather than refusing.
    (raw > 0)
        .then_some(raw)
        .and_then(Pid::from_raw)
        .ok_or_else(|| {
            io::Error::other(format!(
                "{what} has no pid in this process's PID namespace: the kernel answered {raw}"
            ))
        })
}

/// A session's or process group's leader, as the kernel answered it for `what`: `None` for the 0
/// it answers when the leader has no pid in this process's PID namespace.
///
/// # Errors
///
/// When `raw` is below 0.
pub(crate) fn leader(raw: RawPid, what: &str) -> io::Result<Option<Pid>> {
    if raw == 0 {
        Ok(None)
    } else {
        visible(raw, what).map(Some)
    }
}

/// The session `pid` is in, this process's for `None`, by its leader: `None` for a session led
/// from outside this process's PID namespace, as one a container this runs in was started in may
/// be.
///
/// # Errors
///
/// When `pid` has gone, or the kernel won't say.
pub fn session(pid: Option<Pid>) -> io::Result<Option<Pid>> {
    leader(sys::getsid(pid)?, "a session's leader")
}

/// The process group `pid` is in, by its leader: `None` for a group led from outside this
/// process's PID namespace.
///
/// # Errors
///
/// When `pid` has gone, or the kernel won't say.
pub fn group(pid: Pid) -> io::Result<Option<Pid>> {
    leader(sys::getpgid(pid)?, "a process group's leader")
}

/// This process's own group, by its leader: `None` for a group led from outside this process's PID
/// namespace. It can't fail, unlike `group` asked of this process, which a seccomp profile can
/// refuse, so a check that refuses this process's group always has it to refuse.
pub fn own_group() -> Option<Pid> {
    // getpgrp answers no error and nothing below 0, so only its 0 for a leader outside is none.
    Pid::from_raw(sys::getpgrp().max(0))
}

/// The effective uid of the process at the other end of a Unix socket, as it was when it
/// connected. A uid outside this process's user namespace reads as the overflow uid.
///
/// # Errors
///
/// When the socket isn't a connected Unix socket.
pub fn peer_uid(socket: BorrowedFd<'_>) -> io::Result<u32> {
    sys::peer_uid(socket)
}

/// The process at the other end of a Unix socket: on Linux the one that connected
/// (`SO_PEERCRED`), on macOS its last user (`LOCAL_PEERPID`). Either may since have exited, or its
/// pid gone to another process, so a caller checks its start time.
///
/// # Errors
///
/// When the socket isn't a connected Unix socket, or names no process this process can see: one
/// outside its PID namespace, as a host process connecting to a socket in a container is.
pub fn peer_pid(socket: BorrowedFd<'_>) -> io::Result<Pid> {
    visible(sys::peer_pid(socket)?, "the socket's peer")
}

#[cfg(test)]
mod tests {
    use std::os::fd::AsFd as _;
    use std::os::unix::net::UnixStream;

    use rustix::process::{getpgid, getpgrp, getpid, getsid, getuid};

    use super::*;

    #[test]
    fn names_a_pid_above_0_and_refuses_the_0_a_kernel_gives_for_one_outside_this_namespace() {
        assert_eq!(visible(1, "init").unwrap(), Pid::from_raw(1).unwrap());
        assert_eq!(
            visible(i32::MAX, "a pid").unwrap(),
            Pid::from_raw(i32::MAX).unwrap()
        );
        for raw in [0, -1, i32::MIN] {
            let refused = visible(raw, "the socket's peer").unwrap_err();
            assert!(
                refused.to_string().starts_with("the socket's peer "),
                "{raw}: {refused}"
            );
        }
    }

    #[test]
    fn reads_the_0_a_kernel_gives_for_a_leader_outside_this_namespace_as_none() {
        assert_eq!(leader(0, "a leader").unwrap(), None);
        assert_eq!(leader(7, "a leader").unwrap(), Pid::from_raw(7));
        let refused = leader(-1, "a session's leader").unwrap_err();
        assert!(
            refused.to_string().starts_with("a session's leader "),
            "{refused}"
        );
    }

    #[test]
    fn names_this_process_as_the_peer_of_its_own_socket_pair() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        assert_eq!(peer_pid(ours.as_fd()).unwrap(), getpid());
        assert_eq!(peer_uid(ours.as_fd()).unwrap(), getuid().as_raw());
    }

    #[test]
    fn reads_this_process_s_session_as_the_kernel_gives_it() {
        let ours = getsid(None).unwrap();
        assert_eq!(session(None).unwrap(), Some(ours));
        assert_eq!(session(Some(getpid())).unwrap(), Some(ours));
    }

    #[test]
    fn reads_this_process_s_group_as_the_kernel_gives_it() {
        let ours = getpgrp();
        assert_eq!(getpgid(None).unwrap(), ours);
        assert_eq!(own_group(), Some(ours));
        assert_eq!(group(getpid()).unwrap(), Some(ours));
    }

    #[test]
    fn reads_no_session_or_group_of_a_process_that_isn_t_there() {
        let absent = Pid::from_raw(i32::MAX).unwrap();
        assert!(session(Some(absent)).is_err());
        assert!(group(absent).is_err());
    }
}

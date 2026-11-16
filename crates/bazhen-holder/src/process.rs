//! What the kernel says of another process of this user: its parent, its session, and who is at
//! the other end of a Unix socket. Reading only: nothing here reaches a process.

use std::io;
use std::os::fd::BorrowedFd;

use rustix::process::{Pid, getsid};

/// `pid`'s parent: `None` for a process that has none, init or a PID namespace's first process.
///
/// # Errors
///
/// When `pid` has gone or exited, a zombie included, or its record can't be read: which parent it
/// had is then unknown, or no longer its.
pub fn parent(pid: Pid) -> io::Result<Option<Pid>> {
    #[cfg(target_os = "linux")]
    {
        let stat = std::fs::read(format!("/proc/{}/stat", pid.as_raw_pid()))?;
        if matches!(crate::start_time::stat_field(&stat, 3), Some(b"Z" | b"X")) {
            return Err(io::Error::other(format!("process {pid:?} has exited")));
        }
        let raw = crate::start_time::stat_field(&stat, 4)
            .and_then(|field| std::str::from_utf8(field).ok())
            .and_then(|field| field.parse::<i32>().ok())
            .ok_or_else(|| io::Error::other(format!("process {pid:?} names no parent")))?;
        Ok(Pid::from_raw(raw))
    }
    #[cfg(target_os = "macos")]
    {
        if pid.is_init() {
            return Ok(None);
        }
        crate::macos::parent(pid)
            .map(Some)
            .ok_or_else(|| io::Error::other(format!("process {pid:?} can't be read")))
    }
}

/// The session `pid` is in.
///
/// # Errors
///
/// When `pid` has gone, or the kernel won't say.
pub fn session(pid: Pid) -> io::Result<Pid> {
    Ok(getsid(Some(pid))?)
}

/// The effective uid of the process at the other end of a Unix socket, as it was when it
/// connected.
///
/// # Errors
///
/// When the socket isn't a connected Unix socket.
pub fn peer_uid(socket: BorrowedFd<'_>) -> io::Result<u32> {
    #[cfg(target_os = "linux")]
    {
        Ok(rustix::net::sockopt::socket_peercred(socket)?.uid.as_raw())
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::peer_uid(socket)
    }
}

/// The process at the other end of a Unix socket: on Linux the one that connected
/// (`SO_PEERCRED`), on macOS its last user (`LOCAL_PEERPID`). Either may since have exited, or its
/// pid gone to another process, so a caller checks its start time.
///
/// # Errors
///
/// When the socket isn't a connected Unix socket, or names no process.
pub fn peer_pid(socket: BorrowedFd<'_>) -> io::Result<Pid> {
    #[cfg(target_os = "linux")]
    {
        Ok(rustix::net::sockopt::socket_peercred(socket)?.pid)
    }
    #[cfg(target_os = "macos")]
    {
        crate::macos::peer_pid(socket)
    }
}

#[cfg(test)]
mod tests {
    use std::os::fd::AsFd as _;
    use std::os::unix::net::UnixStream;

    use rustix::process::{getpid, getppid, getuid};

    use super::*;

    #[test]
    fn names_this_process_as_the_peer_of_its_own_socket_pair() {
        let (ours, _theirs) = UnixStream::pair().unwrap();
        assert_eq!(peer_pid(ours.as_fd()).unwrap(), getpid());
        assert_eq!(peer_uid(ours.as_fd()).unwrap(), getuid().as_raw());
    }

    #[test]
    fn reads_this_process_s_parent_and_session_as_the_kernel_gives_them() {
        assert_eq!(parent(getpid()).unwrap(), getppid());
        assert_eq!(session(getpid()).unwrap(), getsid(None).unwrap());
    }

    #[test]
    fn reads_no_parent_or_session_of_a_process_that_isn_t_there() {
        let absent = Pid::from_raw(i32::MAX).unwrap();
        assert!(parent(absent).is_err());
        assert!(session(absent).is_err());
    }
}

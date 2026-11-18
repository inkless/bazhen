#![expect(
    unsafe_code,
    reason = "libc's getsid and getpgid, since rustix's getsid, getpgid and getpgrp build a \
              non-zero Pid from what the kernel answers, which is 0 for a leader outside this \
              process's PID namespace; libc's getsockopt(SO_PEERCRED) on Linux, since rustix's \
              socket_peercred builds one from the 0 the kernel answers for a peer outside it, and \
              std's peer_cred is unstable; and on macOS getpeereid and getsockopt's \
              LOCAL_PEERPID, the calls that name a socket peer's user and process, which rustix \
              doesn't cover"
)]

//! The kernel's answers, as the plain integers it gives them.

use std::io;
use std::os::fd::{AsRawFd as _, BorrowedFd};

use rustix::process::{Pid, RawPid};

/// The kernel's `getsid`: the pid of the leader of `pid`'s session, this process's for `None`, in
/// this process's PID namespace, which is 0 when the leader is outside it.
pub(crate) fn getsid(pid: Option<Pid>) -> io::Result<RawPid> {
    let raw = pid.map_or(0, Pid::as_raw_pid);
    // SAFETY: getsid takes a pid by value and reads or writes no memory of this process.
    let session = unsafe { libc::getsid(raw) };
    if session < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(session)
    }
}

/// The kernel's `getpgid`: the pid of the leader of `pid`'s process group, this process's for
/// `None`, in this process's PID namespace, which is 0 when the leader is outside it.
pub(crate) fn getpgid(pid: Option<Pid>) -> io::Result<RawPid> {
    let raw = pid.map_or(0, Pid::as_raw_pid);
    // SAFETY: getpgid takes a pid by value and reads or writes no memory of this process.
    let group = unsafe { libc::getpgid(raw) };
    if group < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(group)
    }
}

/// The effective uid of the process at the other end of a Unix socket, as it was when it
/// connected.
#[cfg(target_os = "linux")]
pub(crate) fn peer_uid(socket: BorrowedFd<'_>) -> io::Result<u32> {
    Ok(peer_credentials(socket)?.uid)
}

/// The pid `SO_PEERCRED` names at the other end of a Unix socket, the process that connected, which
/// is 0 for a process outside this one's PID namespace.
#[cfg(target_os = "linux")]
pub(crate) fn peer_pid(socket: BorrowedFd<'_>) -> io::Result<RawPid> {
    Ok(peer_credentials(socket)?.pid)
}

/// The kernel's `SO_PEERCRED` for a Unix socket: the process at the other end and its user and
/// group as they were when it connected, in this process's namespaces.
#[cfg(target_os = "linux")]
fn peer_credentials(socket: BorrowedFd<'_>) -> io::Result<libc::ucred> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let size = std::mem::size_of::<libc::ucred>();
    let mut len = libc::socklen_t::try_from(size).map_err(io::Error::other)?;
    // SAFETY: `socket` is borrowed, so it stays open for the whole call. `credentials` is a live
    // `ucred` that the call may write through for `len` bytes, its own size, and the kernel writes
    // no more than `len`. A `ucred` is three plain integers, so any bytes written leave a valid one.
    let status = unsafe {
        libc::getsockopt(
            socket.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&raw mut credentials).cast(),
            &raw mut len,
        )
    };
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    if usize::try_from(len).ok() != Some(size) {
        return Err(io::Error::other(format!(
            "SO_PEERCRED answered {len} bytes, not a {size}-byte ucred"
        )));
    }
    Ok(credentials)
}

/// The effective uid of the process at the other end of a Unix socket, as it was when it
/// connected.
#[cfg(target_os = "macos")]
pub(crate) fn peer_uid(socket: BorrowedFd<'_>) -> io::Result<u32> {
    let mut uid: libc::uid_t = 0;
    let mut gid: libc::gid_t = 0;
    // SAFETY: `socket` is an open fd for the whole call, and `uid` and `gid` are writable.
    let status = unsafe { libc::getpeereid(socket.as_raw_fd(), &raw mut uid, &raw mut gid) };
    if status == 0 {
        Ok(uid)
    } else {
        Err(io::Error::last_os_error())
    }
}

/// The process `LOCAL_PEERPID` names at the other end of a Unix socket. As XNU's source reads, that
/// is the peer socket's last user, the last process to send or receive on it, which need not be
/// the one that connected.
#[cfg(target_os = "macos")]
pub(crate) fn peer_pid(socket: BorrowedFd<'_>) -> io::Result<RawPid> {
    let mut pid: libc::pid_t = 0;
    let mut len =
        libc::socklen_t::try_from(std::mem::size_of::<libc::pid_t>()).map_err(io::Error::other)?;
    // SAFETY: `socket` is an open fd for the whole call, and `pid` is writable for `len` bytes,
    // which the call writes no more than.
    let status = unsafe {
        libc::getsockopt(
            socket.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&raw mut pid).cast(),
            &raw mut len,
        )
    };
    if status == 0 {
        Ok(pid)
    } else {
        Err(io::Error::last_os_error())
    }
}

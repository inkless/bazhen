#![expect(
    unsafe_code,
    reason = "a raw pidfd_send_signal syscall is the one way to send signal 0, which sends \
              nothing, through a pidfd, to learn at start whether the holder may send through \
              one at all; rustix's pidfd_send_signal takes only a real signal. And libc's \
              getsockopt(SO_PEERCRED) and getsid, since rustix's socket_peercred and getsid \
              build a non-zero Pid from what the kernel answers, which is 0 for a process \
              outside this one's PID namespace, and std's peer_cred is unstable"
)]

//! What only a raw Linux syscall can tell the holder.

use std::io;
use std::mem;
use std::os::fd::{AsRawFd as _, BorrowedFd};

use rustix::process::Pid;

/// Whether this process may send signals through a pidfd: signal 0, which sends nothing, through
/// one on itself, as a seccomp profile that allows `pidfd_open` but not the send would refuse.
pub(crate) fn may_send_through_a_pidfd() -> io::Result<()> {
    let own = rustix::process::pidfd_open(
        rustix::process::getpid(),
        rustix::process::PidfdFlags::empty(),
    )?;
    let none: *const libc::siginfo_t = std::ptr::null();
    // SAFETY: the syscall takes an fd, a signal number, a siginfo that may be null, and flags; it
    // reads nothing through the null pointer, and signal 0 sends nothing.
    let status = unsafe { libc::syscall(libc::SYS_pidfd_send_signal, own.as_raw_fd(), 0, none, 0) };
    if status == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// The kernel's `SO_PEERCRED` for a Unix socket: the process at the other end and its user and
/// group as they were when it connected, in this process's namespaces. The pid is 0 for a process
/// outside this one's PID namespace.
pub(crate) fn peer_credentials(socket: BorrowedFd<'_>) -> io::Result<libc::ucred> {
    let mut credentials = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let size = mem::size_of::<libc::ucred>();
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

/// The kernel's `getsid`: the pid of the leader of `pid`'s session in this process's PID
/// namespace, which is 0 when the leader is outside it.
pub(crate) fn session(pid: Pid) -> io::Result<libc::pid_t> {
    // SAFETY: getsid takes a pid by value and reads or writes no memory of this process.
    let session = unsafe { libc::getsid(pid.as_raw_pid()) };
    if session < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(session)
    }
}

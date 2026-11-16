#![expect(
    unsafe_code,
    reason = "a raw pidfd_send_signal syscall is the one way to send signal 0, which sends \
              nothing, through a pidfd, to learn at start whether the holder may send through \
              one at all; rustix's pidfd_send_signal takes only a real signal"
)]

//! What only a raw Linux syscall can tell the holder.

use std::io;
use std::os::fd::AsRawFd as _;

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

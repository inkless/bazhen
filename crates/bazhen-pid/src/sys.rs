#![expect(
    unsafe_code,
    reason = "libc's getsid and getpgid, since rustix's getsid, getpgid and getpgrp build a \
              non-zero Pid from what the kernel answers, which is 0 for a leader outside this \
              process's PID namespace; libc's getsockopt(SO_PEERCRED) on Linux, since rustix's \
              socket_peercred builds one from the 0 the kernel answers for a peer outside it, and \
              std's peer_cred is unstable; and on macOS getpeereid and getsockopt's \
              LOCAL_PEERPID, the calls that name a socket peer's user and process, which rustix \
              doesn't cover; and libc's sigaction, the one call that sets a signal's disposition \
              and reads SIGCHLD's SA_NOCLDWAIT flag, and sigemptyset, sigaddset and \
              pthread_sigmask, which unblock a signal, none of which rustix covers; and on macOS \
              proc_pidinfo, the one call that names another process's parent"
)]

//! The kernel's answers, as the plain integers it gives them.

use std::io;
use std::mem::MaybeUninit;
use std::os::fd::{AsRawFd as _, BorrowedFd};
use std::ptr;

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

/// The kernel's `getpgid`: the pid of the leader of `pid`'s process group in this process's PID
/// namespace, which is 0 when the leader is outside it.
pub(crate) fn getpgid(pid: Pid) -> io::Result<RawPid> {
    // SAFETY: getpgid takes a pid by value and reads or writes no memory of this process.
    let group = unsafe { libc::getpgid(pid.as_raw_pid()) };
    if group < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(group)
    }
}

/// The kernel's `getpgrp`, which can't fail: the pid of the leader of this process's group in this
/// process's PID namespace, which is 0 when the leader is outside it.
pub(crate) fn getpgrp() -> RawPid {
    // SAFETY: getpgrp takes nothing and reads or writes no memory of this process.
    unsafe { libc::getpgrp() }
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
    let size = std::mem::size_of::<libc::pid_t>();
    let mut len = libc::socklen_t::try_from(size).map_err(io::Error::other)?;
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
    if status != 0 {
        return Err(io::Error::last_os_error());
    }
    if usize::try_from(len).ok() != Some(size) {
        return Err(io::Error::other(format!(
            "LOCAL_PEERPID answered {len} bytes, not a {size}-byte pid_t"
        )));
    }
    Ok(pid)
}

/// `pid`'s parent, from `proc_pidinfo`'s `proc_bsdshortinfo`, which, unlike `proc_bsdinfo`, it
/// gives for another user's process too. The error is the call's own: `ESRCH` for a pid with no
/// process, or a zombie's.
#[cfg(target_os = "macos")]
pub(crate) fn parent(pid: Pid) -> io::Result<RawPid> {
    let mut info = MaybeUninit::<libc::proc_bsdshortinfo>::uninit();
    let size = libc::c_int::try_from(std::mem::size_of::<libc::proc_bsdshortinfo>())
        .map_err(io::Error::other)?;
    // SAFETY: `info` is writable for `size` bytes, which the call writes no more than, and it
    // returns how many it wrote.
    let written = unsafe {
        libc::proc_pidinfo(
            pid.as_raw_pid(),
            libc::PROC_PIDT_SHORTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size,
        )
    };
    if written <= 0 {
        return Err(io::Error::last_os_error());
    }
    if written != size {
        return Err(io::Error::other(format!(
            "process {pid:?}'s record came short: {written} of {size} bytes"
        )));
    }
    // SAFETY: the call wrote the whole struct, which is plain integers and bytes.
    let info = unsafe { info.assume_init() };
    RawPid::try_from(info.pbsi_ppid).map_err(io::Error::other)
}

/// Sets `signal`'s action back to its default, with no flags and an empty mask.
pub(crate) fn default_action(signal: libc::c_int) -> io::Result<()> {
    let action = blank();
    // SAFETY: `action` is `SIG_DFL` with no flags and an empty mask, which any signal that can be
    // caught may be set to; a null old action asks for nothing back.
    let set = unsafe { libc::sigaction(signal, &raw const action, ptr::null_mut()) };
    if set != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Unblocks `signal` for the calling thread.
pub(crate) fn unblock(signal: libc::c_int) -> io::Result<()> {
    let mut set = MaybeUninit::<libc::sigset_t>::uninit();
    // SAFETY: `set` is writable, and sigemptyset initialises the whole of it.
    let emptied = unsafe { libc::sigemptyset(set.as_mut_ptr()) };
    if emptied != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: sigemptyset, which succeeded, initialised the whole set.
    let mut set = unsafe { set.assume_init() };
    // SAFETY: `set` is an initialised signal set, writable for the call.
    let added = unsafe { libc::sigaddset(&raw mut set, signal) };
    if added != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: `set` is an initialised signal set; a null old set asks for nothing back.
    let unblocked =
        unsafe { libc::pthread_sigmask(libc::SIG_UNBLOCK, &raw const set, ptr::null_mut()) };
    if unblocked != 0 {
        return Err(io::Error::from_raw_os_error(unblocked));
    }
    Ok(())
}

/// SIGCHLD's action, as the kernel gave it back. Only an action read from the kernel can be set
/// again, and the only changes it takes are a default handler and no `SA_NOCLDWAIT`, so a handler it
/// names is one that was already valid to set, with the flags it was set with.
#[derive(Clone, Copy)]
pub(crate) struct SigchldAction(libc::sigaction);

impl SigchldAction {
    pub(crate) fn ignored(&self) -> bool {
        self.0.sa_sigaction == libc::SIG_IGN
    }

    pub(crate) fn no_child_wait(&self) -> bool {
        self.0.sa_flags & libc::SA_NOCLDWAIT != 0
    }

    /// This action, with `SIG_DFL` for its handler.
    pub(crate) fn defaulted(mut self) -> Self {
        self.0.sa_sigaction = libc::SIG_DFL;
        self
    }

    /// This action, without `SA_NOCLDWAIT`.
    pub(crate) fn without_no_child_wait(mut self) -> Self {
        self.0.sa_flags &= !libc::SA_NOCLDWAIT;
        self
    }

    /// Whether its handler is `handle`, the one `set_sigchld_for_test` sets for `Nothing`.
    #[cfg(test)]
    pub(crate) fn handled(&self) -> bool {
        self.0.sa_sigaction == nothing()
    }
}

/// What SIGCHLD does now.
pub(crate) fn sigchld() -> io::Result<SigchldAction> {
    let mut current = blank();
    // SAFETY: a null new action changes nothing; `current` is valid for the write of the old one.
    let read = unsafe { libc::sigaction(libc::SIGCHLD, ptr::null(), &raw mut current) };
    if read != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(SigchldAction(current))
}

/// Sets SIGCHLD's action to `action`.
pub(crate) fn set_sigchld(action: SigchldAction) -> io::Result<()> {
    // SAFETY: `action` is one the kernel gave back, perhaps with `SIG_DFL` for its handler and
    // without `SA_NOCLDWAIT`, so a handler it names is the one already set, and was valid to set.
    let set = unsafe { libc::sigaction(libc::SIGCHLD, &raw const action.0, ptr::null_mut()) };
    if set != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// The handlers a test may give SIGCHLD.
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub(crate) enum TestHandler {
    Default,
    Ignore,
    /// `handle`, which does nothing.
    Nothing,
}

/// Sets SIGCHLD to `handler`, with `SA_NOCLDWAIT` when `no_child_wait`, for a test, which nextest
/// runs in a process of its own.
#[cfg(test)]
pub(crate) fn set_sigchld_for_test(handler: TestHandler, no_child_wait: bool) -> io::Result<()> {
    let mut action = blank();
    action.sa_sigaction = match handler {
        TestHandler::Default => libc::SIG_DFL,
        TestHandler::Ignore => libc::SIG_IGN,
        TestHandler::Nothing => nothing(),
    };
    if no_child_wait {
        action.sa_flags = libc::SA_NOCLDWAIT;
    }
    // SAFETY: `action` names `SIG_DFL`, `SIG_IGN` or `handle`, which does nothing and so is safe
    // to run at any point, with no flag but `SA_NOCLDWAIT`; a null old action asks for nothing back.
    let set = unsafe { libc::sigaction(libc::SIGCHLD, &raw const action, ptr::null_mut()) };
    if set != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(test)]
fn nothing() -> libc::sighandler_t {
    handle as extern "C" fn(libc::c_int) as libc::sighandler_t
}

/// A handler that does nothing, which is safe to run whenever a signal comes.
#[cfg(test)]
extern "C" fn handle(_: libc::c_int) {}

/// A `sigaction` of `SIG_DFL`, no flags and an empty mask.
fn blank() -> libc::sigaction {
    // SAFETY: a `sigaction` is integers, a signal set and, on Linux, an optional function pointer,
    // for each of which all zeros is valid: `SIG_DFL`, no flags, an empty set and no restorer.
    unsafe { std::mem::zeroed() }
}

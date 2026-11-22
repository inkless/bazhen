#![expect(
    unsafe_code,
    reason = "libc's sigaction, the one call that sets SIGCHLD's disposition and reads its \
              SA_NOCLDWAIT flag; rustix covers neither"
)]

//! SIGCHLD's disposition, which decides whether the kernel keeps an exited child for its parent
//! to wait for. Ignored, or with `SA_NOCLDWAIT`, it reaps each child itself as it exits, and the
//! child's pid is free at once: a `Child` that names it, or a group it led, may then be another
//! process's. A process inherits an ignored SIGCHLD from whatever started it, across `exec`.

use std::io;
use std::ptr;

/// Gives SIGCHLD its default disposition, with no flags, so the kernel keeps each exited child
/// until it is waited for. It replaces a handler set before it, so a daemon calls it first, before
/// it starts any child.
///
/// # Errors
///
/// When the kernel refuses the change.
pub fn keep_exited_children() -> io::Result<()> {
    set(libc::SIG_DFL, 0)
}

/// Whether the kernel keeps an exited child until it is waited for: SIGCHLD isn't ignored and
/// has no `SA_NOCLDWAIT`.
///
/// # Errors
///
/// When the kernel won't say.
pub fn children_kept() -> io::Result<bool> {
    let mut current = blank();
    // SAFETY: a null new action changes nothing; `current` is valid for the write of the old one.
    let read = unsafe { libc::sigaction(libc::SIGCHLD, ptr::null(), &raw mut current) };
    if read != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(current.sa_sigaction != libc::SIG_IGN && current.sa_flags & libc::SA_NOCLDWAIT == 0)
}

/// How a test leaves SIGCHLD before it calls `keep_exited_children`, as a careless parent could.
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub(crate) enum Careless {
    Ignored,
    NoChildWait,
}

/// Leaves SIGCHLD as `careless` says, for a test, which nextest runs in a process of its own.
#[cfg(test)]
pub(crate) fn make_careless(careless: Careless) -> io::Result<()> {
    match careless {
        Careless::Ignored => set(libc::SIG_IGN, 0),
        Careless::NoChildWait => set(libc::SIG_DFL, libc::SA_NOCLDWAIT),
    }
}

/// Sets SIGCHLD to `handler`, `SIG_DFL` or `SIG_IGN`, with `flags`.
fn set(handler: libc::sighandler_t, flags: libc::c_int) -> io::Result<()> {
    let mut action = blank();
    action.sa_sigaction = handler;
    action.sa_flags = flags;
    // SAFETY: `action` names no function, only `SIG_DFL` or `SIG_IGN`, so nothing of ours ever
    // runs as a handler; a null old action asks for nothing back.
    let set = unsafe { libc::sigaction(libc::SIGCHLD, &raw const action, ptr::null_mut()) };
    if set != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// A `sigaction` of `SIG_DFL`, no flags and an empty mask.
fn blank() -> libc::sigaction {
    // SAFETY: a `sigaction` is integers, a signal set and, on Linux, an optional function pointer,
    // for each of which all zeros is valid: `SIG_DFL`, no flags, an empty set and no restorer.
    unsafe { std::mem::zeroed() }
}

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

/// Makes the kernel keep each exited child until it is waited for: an ignored SIGCHLD gets its
/// default, and `SA_NOCLDWAIT` is dropped. A handler already set, such as tokio's, which its
/// `Child::wait` needs, is kept as it is, with its mask and its other flags. A daemon calls it
/// before it starts any child.
///
/// # Errors
///
/// When the kernel won't say what SIGCHLD does, or refuses the change.
pub fn keep_exited_children() -> io::Result<()> {
    let mut action = current()?;
    let ignored = action.sa_sigaction == libc::SIG_IGN;
    if !ignored && action.sa_flags & libc::SA_NOCLDWAIT == 0 {
        return Ok(());
    }
    if ignored {
        action.sa_sigaction = libc::SIG_DFL;
    }
    action.sa_flags &= !libc::SA_NOCLDWAIT;
    // SAFETY: `action` is the one the kernel gave back, but with `SIG_DFL` for `SIG_IGN` and
    // without `SA_NOCLDWAIT`, so a handler it names is the one already set, and was valid to set.
    let set = unsafe { libc::sigaction(libc::SIGCHLD, &raw const action, ptr::null_mut()) };
    if set != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

/// Whether the kernel keeps an exited child until it is waited for: SIGCHLD isn't ignored and
/// has no `SA_NOCLDWAIT`.
///
/// # Errors
///
/// When the kernel won't say.
pub fn children_kept() -> io::Result<bool> {
    let action = current()?;
    Ok(action.sa_sigaction != libc::SIG_IGN && action.sa_flags & libc::SA_NOCLDWAIT == 0)
}

/// What SIGCHLD does now.
fn current() -> io::Result<libc::sigaction> {
    let mut current = blank();
    // SAFETY: a null new action changes nothing; `current` is valid for the write of the old one.
    let read = unsafe { libc::sigaction(libc::SIGCHLD, ptr::null(), &raw mut current) };
    if read != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(current)
}

/// How a test leaves SIGCHLD before it calls `keep_exited_children`, as a careless parent could,
/// or as a runtime that set its own handler first does.
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
pub(crate) enum Careless {
    Ignored,
    NoChildWait,
    Handled,
    HandledNoChildWait,
}

/// Leaves SIGCHLD as `careless` says, for a test, which nextest runs in a process of its own.
#[cfg(test)]
pub(crate) fn make_careless(careless: Careless) -> io::Result<()> {
    let handler = handle as extern "C" fn(libc::c_int) as libc::sighandler_t;
    match careless {
        Careless::Ignored => set(libc::SIG_IGN, 0),
        Careless::NoChildWait => set(libc::SIG_DFL, libc::SA_NOCLDWAIT),
        Careless::Handled => set(handler, 0),
        Careless::HandledNoChildWait => set(handler, libc::SA_NOCLDWAIT),
    }
}

/// Whether SIGCHLD's handler is the one `make_careless` sets.
#[cfg(test)]
pub(crate) fn handled() -> io::Result<bool> {
    let handler = handle as extern "C" fn(libc::c_int) as libc::sighandler_t;
    Ok(current()?.sa_sigaction == handler)
}

/// A handler that does nothing, which is safe to run whenever a signal comes.
#[cfg(test)]
extern "C" fn handle(_: libc::c_int) {}

/// Sets SIGCHLD to `handler`, `SIG_DFL`, `SIG_IGN` or `handle`, with `flags`, for a test.
#[cfg(test)]
fn set(handler: libc::sighandler_t, flags: libc::c_int) -> io::Result<()> {
    let mut action = blank();
    action.sa_sigaction = handler;
    action.sa_flags = flags;
    // SAFETY: `action` names `SIG_DFL`, `SIG_IGN` or `handle`, which does nothing and so is safe
    // to run at any point; a null old action asks for nothing back.
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

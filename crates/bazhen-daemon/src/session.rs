#![expect(
    unsafe_code,
    reason = "Command::pre_exec runs a closure between fork and exec, the one place a child can \
              lead a session of its own before it runs, as Node's `detached` makes one; only \
              unsafe can register it"
)]

//! The detached daemon's session: made in the child between fork and exec, so no signal to the
//! starting terminal's group, a Ctrl-C included, can reach it at any point after the fork.

use std::process::Command;

/// Makes `command`'s child the leader of a session of its own before it execs. Spawning fails if
/// it can't be made one.
pub(crate) fn in_own_session(command: &mut Command) -> &mut Command {
    use std::os::unix::process::CommandExt;
    // SAFETY: the closure runs in the forked child before exec, where only async-signal-safe
    // calls are sound. It makes one setsid(2), a raw syscall through rustix, which is, and it
    // allocates nothing and takes no lock.
    unsafe {
        command.pre_exec(|| rustix::process::setsid().map(drop).map_err(Into::into));
    }
    command
}

/// Whether this process leads its session, as one `in_own_session` started does.
pub(crate) fn leads_own_session() -> bool {
    rustix::process::getsid(None).is_ok_and(|sid| sid == rustix::process::getpid())
}

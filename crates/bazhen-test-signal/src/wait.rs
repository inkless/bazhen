//! Waiting a bound for a child the test started. A thread that reaps the child while the bound
//! runs out frees its pid for another process, and a signal sent at the bound then reaches that
//! one. So the wait here only watches: the child stays unreaped until its owner reaps it, after
//! any signal. That holds only while the kernel keeps exited children, so neither wait starts
//! while SIGCHLD is ignored or set with `SA_NOCLDWAIT`.

use std::io;
use std::process::{Child, ExitStatus};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, waitid};

/// Why a child can't be waited for a bound here: the kernel may reap every child itself as it
/// exits.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error(
    "Refusing to wait for a child: SIGCHLD is ignored or set with SA_NOCLDWAIT, so the kernel \
     may reap each child as it exits, and by the bound its pid may be another process's. Run the \
     tests from a process that leaves SIGCHLD at its default"
)]
pub struct ChildrenNotKept;

/// Nothing, while the kernel keeps exited children until they are waited for.
fn require_children_kept() -> io::Result<()> {
    if bazhen_pid::children_kept()? {
        Ok(())
    } else {
        Err(io::Error::other(ChildrenNotKept))
    }
}

/// Whether `child` ended within `bound`. It is left unreaped, so until it is reaped through
/// `child` its pid is still its own, and a signal sent to it reaches it alone. Pass a child not
/// yet waited for: once reaped, as `Child::try_wait` or `Child::wait` reap it, its pid may be
/// another child's of this process, which this would watch in its place. A pid with no child left
/// to wait for counts as ended.
///
/// # Errors
///
/// When the kernel reaps children itself (`ChildrenNotKept`), or the child can't be waited for.
pub fn ended_within(child: &Child, bound: Duration) -> io::Result<bool> {
    require_children_kept()?;
    let pid = Pid::from_child(child);
    let (tell, ended) = mpsc::channel();
    // Past the bound it is left waiting, and returns once the child ends.
    thread::spawn(move || {
        let _ = tell.send(watch(pid));
    });
    match ended.recv_timeout(bound) {
        Ok(watched) => watched.map(|()| true),
        Err(RecvTimeoutError::Timeout) => Ok(false),
        Err(RecvTimeoutError::Disconnected) => Err(io::Error::other("the watch panicked")),
    }
}

/// Blocks until `pid`, a child of this process, has ended, without reaping it. A pid that is no
/// child left to wait for was one that ended and was reaped.
fn watch(pid: Pid) -> io::Result<()> {
    loop {
        match waitid(
            WaitId::Pid(pid),
            WaitIdOptions::EXITED | WaitIdOptions::NOWAIT,
        ) {
            Err(rustix::io::Errno::INTR) => {}
            Err(rustix::io::Errno::CHILD) => return Ok(()),
            waited => return waited.map(|_| ()).map_err(io::Error::from),
        }
    }
}

/// How `child` ended, if it did within `bound`; `None` if it was still running then, when it is
/// killed. Reaped either way. A child already reaped through `child` gives the status std kept,
/// and its pid, perhaps another process's by now, is neither watched nor signalled. Unlike
/// `Child::wait`, this leaves the child's stdin open, so one that would end at the end of its
/// input is still running at the bound, and is killed.
///
/// # Errors
///
/// When the kernel reaps children itself (`ChildrenNotKept`), before anything is waited for or
/// sent, or the child can't be waited for, or the kill is refused (`crate::Tester::check`).
pub fn end_within(child: &mut Child, bound: Duration) -> io::Result<Option<ExitStatus>> {
    require_children_kept()?;
    if let Some(status) = child.try_wait()? {
        return Ok(Some(status));
    }
    if ended_within(child, bound)? {
        return child.wait().map(Some);
    }
    // Unreaped, so its pid is still its own.
    crate::signal(child.id(), Signal::KILL).map_err(io::Error::other)?;
    child.wait()?;
    Ok(None)
}

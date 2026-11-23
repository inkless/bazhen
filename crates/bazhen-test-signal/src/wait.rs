//! Waiting a bound for a child the test started. A thread that reaps the child while the bound
//! runs out frees its pid for another process, and a signal sent at the bound then reaches that
//! one. So the wait here only watches: the child stays unreaped until its owner reaps it, after
//! any signal.

use std::io;
use std::process::{Child, ExitStatus};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::thread;
use std::time::Duration;

use rustix::process::{Pid, Signal, WaitId, WaitIdOptions, waitid};

/// Whether `child` ended within `bound`. One still unreaped is left so, and until it is reaped
/// through `child` its pid is still its own, so a signal sent to it reaches it alone. One already
/// reaped, as `Child::try_wait` does, has ended: its pid may be another process's by now.
///
/// # Errors
///
/// When the child can't be waited for.
pub fn ended_within(child: &Child, bound: Duration) -> io::Result<bool> {
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
/// killed. Reaped either way.
///
/// # Errors
///
/// When the child can't be waited for, or the kill is refused (`crate::Tester::check`).
pub fn end_within(child: &mut Child, bound: Duration) -> io::Result<Option<ExitStatus>> {
    if ended_within(child, bound)? {
        return child.wait().map(Some);
    }
    // Unreaped, so its pid is still its own.
    crate::signal(child.id(), Signal::KILL).map_err(io::Error::other)?;
    child.wait()?;
    Ok(None)
}

//! What the runtime asks of the OS: starting a holder, probing containment, telling a holder to
//! bind again, and reading processes. Its tests replace it, so no real process is reached.

use std::ffi::OsString;
use std::fmt;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use bazhen_holder::{process, start_time};
use bazhen_host_guard::holder::{
    HolderProcess, Recorded, StartError, StartHolderOptions, StartedHolder, holder_running,
    rebind_holder_socket, start_holder,
};
use bazhen_host_guard::scope::{
    CapsRefused, Containment, TerminalCaps, in_terminal_scope, probe_containment,
};
use rustix::process::Pid;

pub(crate) type Boxed<T> = Pin<Box<dyn Future<Output = T> + Send>>;

/// A holder that said `ready`, and the handle that reaps it, which only a real start has.
pub(crate) struct Started {
    pub(crate) holder: HolderProcess,
    pub(crate) handle: Option<StartedHolder>,
}

/// The leader of a terminal's foreground group, as the kernel showed it in one read: its name,
/// when it started, and its directory, where the OS shows one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Leader {
    pub(crate) comm: OsString,
    pub(crate) start: u64,
    pub(crate) cwd: Option<PathBuf>,
}

pub(crate) trait Host: Send + Sync + fmt::Debug {
    fn start(&self, options: StartHolderOptions) -> Boxed<Result<Started, StartError>>;
    fn probe(&self, caps: TerminalCaps) -> Boxed<Result<Containment, CapsRefused>>;
    /// SIGUSR1 to a holder whose socket is gone, through host-guard's check of it.
    fn rebind(&self, holder: HolderProcess) -> Boxed<Result<bool, bazhen_host_guard::Error>>;
    /// Whether the pid still belongs to the holder. A failed read leaves it unknown.
    fn running(&self, holder: HolderProcess) -> Option<bool>;
    /// Keep an unreadable holder until the host can show that it is gone.
    fn may_run(&self, holder: HolderProcess) -> bool {
        self.running(holder).unwrap_or(true)
    }
    fn leader(&self, pid: Pid) -> Option<Leader>;
    fn in_scope(&self, pid: Pid) -> Option<bool>;
    /// When `pid` started, and its arguments.
    fn process(&self, pid: Pid) -> Option<(u64, Vec<OsString>)>;
}

/// This machine.
#[derive(Debug)]
pub(crate) struct System;

/// Nothing to record: the runtime finds its holders by their sockets.
fn unrecorded(_: HolderProcess) -> impl Future<Output = Recorded> + Send {
    std::future::ready(Ok(()))
}

impl Host for System {
    fn start(&self, options: StartHolderOptions) -> Boxed<Result<Started, StartError>> {
        Box::pin(async move {
            let started = start_holder(options, unrecorded).await?;
            Ok(Started {
                holder: started.holder,
                handle: Some(started),
            })
        })
    }

    fn probe(&self, caps: TerminalCaps) -> Boxed<Result<Containment, CapsRefused>> {
        Box::pin(async move { probe_containment(&caps).await })
    }

    fn rebind(&self, holder: HolderProcess) -> Boxed<Result<bool, bazhen_host_guard::Error>> {
        Box::pin(rebind_holder_socket(holder))
    }

    fn running(&self, holder: HolderProcess) -> Option<bool> {
        holder_running(holder)
    }

    fn leader(&self, pid: Pid) -> Option<Leader> {
        let start = start_time::of(pid).ok()?.get();
        let comm = process::comm(pid).ok()?;
        // Where no `/proc` shows it, as on macOS, the directory is left unknown.
        let cwd = std::fs::read_link(format!("/proc/{}/cwd", pid.as_raw_pid())).ok();
        // Read again, so a pid reused between the reads reads as no leader at all.
        (start_time::of(pid).ok()?.get() == start).then_some(Leader { comm, start, cwd })
    }

    fn in_scope(&self, pid: Pid) -> Option<bool> {
        in_terminal_scope(pid)
    }

    fn process(&self, pid: Pid) -> Option<(u64, Vec<OsString>)> {
        let start = start_time::of(pid).ok()?.get();
        Some((start, process::args(pid).ok()?))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_this_process_as_a_leader_with_its_name_and_start() {
        let me = rustix::process::getpid();
        let leader = System.leader(me).unwrap();
        assert_eq!(
            (leader.comm, leader.start),
            (
                process::comm(me).unwrap(),
                start_time::of(me).unwrap().get()
            )
        );
    }
}

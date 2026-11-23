//! A `Host` that reaches no process: what it starts, probes and finds is what a test sets.

use std::ffi::OsString;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use bazhen_host_guard::holder::{HolderProcess, StartError, StartHolderOptions};
use bazhen_host_guard::scope::{CapsRefused, Containment, TerminalCaps};

use crate::host::{Boxed, Host, Leader, Started};

/// The pid and start of every holder it starts, as `fake_hello` names them.
pub(crate) const PID: i32 = 4242;
pub(crate) const START: u64 = 1_700_000_000;

#[derive(Debug, Default)]
pub(crate) struct FakeHost {
    pub(crate) started: Mutex<Vec<StartHolderOptions>>,
    pub(crate) probes: AtomicUsize,
    pub(crate) containment: Option<Result<Containment, CapsRefused>>,
    /// Whether the holder a pid names is taken for running.
    pub(crate) running: bool,
    pub(crate) rebinds: bool,
    pub(crate) rebound: Mutex<Vec<HolderProcess>>,
    pub(crate) leader: Option<Leader>,
}

impl Host for FakeHost {
    fn start(&self, options: StartHolderOptions) -> Boxed<Result<Started, StartError>> {
        self.started.lock().unwrap().push(options);
        let holder = HolderProcess {
            pid: rustix::process::Pid::from_raw(PID).unwrap(),
            start: START,
        };
        Box::pin(std::future::ready(Ok(Started {
            holder,
            handle: None,
        })))
    }

    fn probe(&self, _: TerminalCaps) -> Boxed<Result<Containment, CapsRefused>> {
        self.probes.fetch_add(1, Ordering::Relaxed);
        Box::pin(std::future::ready(self.containment.clone().unwrap()))
    }

    fn rebind(&self, holder: HolderProcess) -> Boxed<Result<bool, bazhen_host_guard::Error>> {
        self.rebound.lock().unwrap().push(holder);
        Box::pin(std::future::ready(Ok(self.rebinds)))
    }

    fn runs(&self, _: HolderProcess) -> bool {
        self.running
    }

    fn leader(&self, _: rustix::process::Pid) -> Option<Leader> {
        self.leader.clone()
    }

    fn in_scope(&self, _: rustix::process::Pid) -> Option<bool> {
        Some(true)
    }

    fn process(&self, _: rustix::process::Pid) -> Option<(u64, Vec<OsString>)> {
        Some((
            START,
            vec!["/opt/bz/holder/0123456789abcdef/bazhen-holder".into()],
        ))
    }
}

//! How many terminals may be open at once (`terminals/budget.ts`): `terminals.max_open`, and
//! enough of the machine's PTYs left free that the user's own terminals and `ssh` still open.

use std::sync::{Arc, Mutex, PoisonError};

use bazhen_protocol::daemon::{HostPtys, Refusing, Terminals};

/// The machine's PTYs, as the host guard counts them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum Ptys {
    Counted {
        used: u64,
        max: u64,
        /// False where `used` is an upper bound, counting device nodes that can outlive a PTY.
        exact: bool,
        /// The setting that raises `max`.
        limit: &'static str,
    },
    Unread(String),
}

/// What counts the machine's PTYs, so a test can stand in for it.
pub(crate) trait CountPtys: Send + Sync + std::fmt::Debug {
    fn count(&self) -> Ptys;
}

impl CountPtys for bazhen_host_guard::ptys::PtyReader {
    fn count(&self) -> Ptys {
        match self.read() {
            bazhen_host_guard::ptys::HostPtys::Counted {
                used,
                max,
                exact,
                limit,
            } => Ptys::Counted {
                used,
                max,
                exact,
                limit,
            },
            bazhen_host_guard::ptys::HostPtys::Unread { reason } => Ptys::Unread(reason),
        }
    }
}

/// A new terminal refused: past `terminals.max_open`, or with the machine short of PTYs.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub(crate) struct TerminalLimit {
    pub(crate) message: String,
    pub(crate) open: u64,
    /// Whether the machine's own PTYs refused it, rather than the budget.
    pub(crate) host: bool,
}

/// What the store counts of the terminals now: those open, and those still being created, whose
/// PTYs may not be in the machine's count yet, so a burst of opens would otherwise all pass it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct Counts {
    pub(crate) open: u64,
    pub(crate) starting: u64,
}

/// PTYs left for the rest of the machine: a tenth of them, and never fewer than 16.
pub(crate) fn host_headroom(max: u64) -> u64 {
    max.div_ceil(10).max(16)
}

fn terminals(n: u64) -> String {
    if n == 1 {
        "1 terminal is".to_owned()
    } else {
        format!("{n} terminals are")
    }
}

/// Where the machine stands: short when one more PTY would leave less than its headroom free.
enum HostCheck {
    Unread(String),
    Room,
    Short {
        used: u64,
        keep: u64,
        max: u64,
        exact: bool,
        limit: &'static str,
    },
}

/// What it has said, each said once while it holds.
#[derive(Debug, Default)]
struct Warned {
    unreadable: bool,
    short: bool,
}

/// Admits new terminals. The counts are the store's, read in the transaction that records the
/// terminal, so admitting there reserves its slot, and every end the store records gives it back.
pub(crate) struct Budget {
    max: u64,
    host: Arc<dyn CountPtys>,
    warn: Box<dyn Fn(&str) + Send + Sync>,
    warned: Mutex<Warned>,
}

impl std::fmt::Debug for Budget {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Budget")
            .field("max", &self.max)
            .field("host", &self.host)
            .finish_non_exhaustive()
    }
}

impl Budget {
    /// `max` at once, on the machine `host` counts, with what it says once given to `warn`.
    pub(crate) fn new(
        max: u64,
        host: Arc<dyn CountPtys>,
        warn: Box<dyn Fn(&str) + Send + Sync>,
    ) -> Self {
        Self {
            max,
            host,
            warn,
            warned: Mutex::new(Warned::default()),
        }
    }

    /// Refuses one more terminal when it may not open. Call it in the transaction that records
    /// one.
    pub(crate) fn admit(&self, counts: Counts) -> Result<(), TerminalLimit> {
        if let Some(over) = self.budget_refusal(counts.open) {
            return Err(over);
        }
        let mut warned = self.warned.lock().unwrap_or_else(PoisonError::into_inner);
        match host_check(&self.host.count(), counts.starting) {
            HostCheck::Unread(reason) => {
                if !warned.unreadable {
                    warned.unreadable = true;
                    (self.warn)(&format!(
                        "the machine's PTYs can't be counted ({reason}): only terminals.max_open limits new terminals"
                    ));
                }
                Ok(())
            }
            HostCheck::Room => {
                warned.short = false;
                Ok(())
            }
            short @ HostCheck::Short { .. } => {
                if let Some(refused) = Self::host_refusal(counts.open, &short) {
                    return Err(refused);
                }
                // An approximate count can include PTYs already closed, so it warns rather than
                // refuse.
                if let HostCheck::Short {
                    used, keep, max, ..
                } = short
                    && !warned.short
                {
                    warned.short = true;
                    (self.warn)(&format!(
                        "the machine may have as many as {used} of {max} PTYs in use, within the {keep} Bazhen keeps free; new terminals still open, since the count can include closed PTYs"
                    ));
                }
                Ok(())
            }
        }
    }

    /// What `bazhen doctor` shows.
    pub(crate) fn report(&self, counts: Counts) -> Terminals {
        let counted = self.host.count();
        let check = host_check(&counted, counts.starting);
        let refusing = if self.budget_refusal(counts.open).is_some() {
            Some(Refusing::Budget)
        } else if Self::host_refusal(counts.open, &check).is_some() {
            Some(Refusing::Host)
        } else {
            None
        };
        Terminals {
            open: counts.open,
            max: self.max,
            host: match counted {
                Ptys::Counted {
                    used, max, exact, ..
                } => Some(HostPtys { used, max, exact }),
                Ptys::Unread(_) => None,
            },
            refusing,
        }
    }

    /// What a start says: terminals kept above a lowered budget, and a budget the machine can't
    /// meet.
    pub(crate) fn startup_warnings(&self, open: u64) -> Vec<String> {
        let max = self.max;
        let mut warnings = Vec::new();
        if open > max {
            warnings.push(format!(
                "{} open, above terminals.max_open ({max}): they keep running, and a new one opens once {} of them have closed",
                terminals(open),
                open - max + 1
            ));
        }
        if let Ptys::Counted { max: host, .. } = self.host.count()
            && max > host
        {
            warnings.push(format!(
                "terminals.max_open ({max}) is above the machine's {host} PTYs: the machine's own limit is reached first"
            ));
        }
        warnings
    }

    fn budget_refusal(&self, open: u64) -> Option<TerminalLimit> {
        let max = self.max;
        (open >= max).then(|| TerminalLimit {
            message: format!(
                "{} open, the most at once (terminals.max_open = {max}): close one you no longer need to open another",
                terminals(open)
            ),
            open,
            host: false,
        })
    }

    /// The refusal a short machine gives, where its count is exact enough to refuse on.
    fn host_refusal(open: u64, check: &HostCheck) -> Option<TerminalLimit> {
        let HostCheck::Short {
            used,
            keep,
            max,
            exact: true,
            limit,
        } = *check
        else {
            return None;
        };
        Some(TerminalLimit {
            message: format!(
                "the machine has {used} of {max} PTYs in use or being opened, and Bazhen keeps {keep} free for the rest of the system: close a terminal, or raise {limit}"
            ),
            open,
            host: true,
        })
    }
}

/// Where the machine stands once `starting` more terminals hold their PTYs.
fn host_check(counted: &Ptys, starting: u64) -> HostCheck {
    match *counted {
        Ptys::Unread(ref reason) => HostCheck::Unread(reason.clone()),
        Ptys::Counted {
            used,
            max,
            exact,
            limit,
        } => {
            let keep = host_headroom(max);
            let used = used.saturating_add(starting);
            if used >= max.saturating_sub(keep) {
                HostCheck::Short {
                    used,
                    keep,
                    max,
                    exact,
                    limit,
                }
            } else {
                HostCheck::Room
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    /// A machine whose count a test sets.
    #[derive(Debug)]
    pub(crate) struct Machine(pub(crate) Mutex<Ptys>);

    impl CountPtys for Machine {
        fn count(&self) -> Ptys {
            self.0.lock().unwrap().clone()
        }
    }

    pub(crate) fn roomy() -> Ptys {
        Ptys::Counted {
            used: 10,
            max: 4096,
            exact: true,
            limit: "kernel.pty.max",
        }
    }

    /// A host with exactly `free` PTYs left after one more opens.
    fn leaving(free: u64, exact: bool) -> Ptys {
        Ptys::Counted {
            used: 511 - 1 - free,
            max: 511,
            exact,
            limit: if exact {
                "kernel.pty.max"
            } else {
                "kern.tty.ptmx_max"
            },
        }
    }

    struct Fixture {
        budget: Budget,
        machine: Arc<Machine>,
        warnings: Arc<Mutex<Vec<String>>>,
    }

    fn budget(max: u64, host: Ptys) -> Fixture {
        let machine = Arc::new(Machine(Mutex::new(host)));
        let warnings = Arc::new(Mutex::new(Vec::new()));
        let said = Arc::clone(&warnings);
        let budget = Budget::new(
            max,
            Arc::clone(&machine) as Arc<dyn CountPtys>,
            Box::new(move |m| said.lock().unwrap().push(m.to_owned())),
        );
        Fixture {
            budget,
            machine,
            warnings,
        }
    }

    fn counts(open: u64, starting: u64) -> Counts {
        Counts { open, starting }
    }

    #[test]
    fn admits_a_terminal_while_fewer_than_the_budget_are_open() {
        assert_eq!(budget(3, roomy()).budget.admit(counts(2, 0)), Ok(()));
    }

    #[test]
    fn refuses_one_at_the_budget_saying_how_many_are_open_and_what_to_do() {
        let refused = budget(3, roomy()).budget.admit(counts(3, 0)).unwrap_err();
        assert_eq!(
            refused,
            TerminalLimit {
                message: "3 terminals are open, the most at once (terminals.max_open = 3): close one you no longer need to open another".to_owned(),
                open: 3,
                host: false,
            }
        );
        let one = budget(1, roomy()).budget.admit(counts(1, 0)).unwrap_err();
        assert!(one.message.starts_with("1 terminal is open"), "{one}");
    }

    #[test]
    fn refuses_one_above_a_budget_lowered_below_what_is_open() {
        assert_eq!(
            budget(2, roomy())
                .budget
                .admit(counts(5, 0))
                .unwrap_err()
                .open,
            5
        );
    }

    #[test]
    fn admits_again_once_a_terminal_has_ended() {
        let f = budget(3, roomy());
        assert!(f.budget.admit(counts(3, 0)).is_err());
        assert_eq!(f.budget.admit(counts(2, 0)), Ok(()));
    }

    #[test]
    fn keeps_ptys_free_for_the_rest_of_the_machine_a_tenth_of_them_and_never_fewer_than_16() {
        assert_eq!(
            [host_headroom(4096), host_headroom(511), host_headroom(100)],
            [410, 52, 16]
        );
    }

    #[test]
    fn refuses_on_an_exact_count_that_would_leave_the_machine_less_than_its_headroom() {
        let f = budget(3, leaving(host_headroom(511) - 1, true));
        let refused = f.budget.admit(counts(0, 0)).unwrap_err();
        assert_eq!(
            refused.message,
            "the machine has 459 of 511 PTYs in use or being opened, and Bazhen keeps 52 free for the rest of the system: close a terminal, or raise kernel.pty.max"
        );
        assert!(refused.host);
    }

    #[test]
    fn counts_the_terminals_still_being_created_as_ptys_the_machine_s_count_may_not_show_yet() {
        let f = budget(3, leaving(host_headroom(511), true));
        let refused = f.budget.admit(counts(0, 1)).unwrap_err();
        assert!(
            refused
                .message
                .contains("459 of 511 PTYs in use or being opened"),
            "{refused}"
        );
    }

    #[test]
    fn admits_on_an_exact_count_that_leaves_the_machine_exactly_its_headroom() {
        let f = budget(3, leaving(host_headroom(511), true));
        assert_eq!(f.budget.admit(counts(0, 0)), Ok(()));
    }

    #[test]
    fn only_warns_once_while_short_on_an_approximate_count_that_would_pass_the_headroom() {
        let short = leaving(host_headroom(511) - 1, false);
        let f = budget(3, short.clone());
        f.budget.admit(counts(0, 0)).unwrap();
        f.budget.admit(counts(0, 0)).unwrap();
        *f.machine.0.lock().unwrap() = roomy();
        f.budget.admit(counts(0, 0)).unwrap();
        *f.machine.0.lock().unwrap() = short;
        f.budget.admit(counts(0, 0)).unwrap();
        let warnings = f.warnings.lock().unwrap();
        assert_eq!(warnings.len(), 2, "{warnings:?}");
        assert!(
            warnings
                .iter()
                .all(|w| w.contains("may have as many as 459 of 511 PTYs in use")),
            "{warnings:?}"
        );
    }

    #[test]
    fn still_enforces_the_budget_when_the_machine_s_ptys_can_t_be_counted_saying_so_once() {
        let f = budget(2, Ptys::Unread("no /proc".to_owned()));
        f.budget.admit(counts(0, 0)).unwrap();
        f.budget.admit(counts(1, 0)).unwrap();
        assert!(f.budget.admit(counts(2, 0)).is_err());
        assert_eq!(
            *f.warnings.lock().unwrap(),
            [
                "the machine's PTYs can't be counted (no /proc): only terminals.max_open limits new terminals"
            ]
        );
    }

    #[test]
    fn warns_at_start_about_terminals_kept_above_the_budget_and_a_budget_above_the_machine_s_ptys()
    {
        let host = Ptys::Counted {
            used: 10,
            max: 50,
            exact: true,
            limit: "kernel.pty.max",
        };
        assert_eq!(
            budget(64, host).budget.startup_warnings(70),
            [
                "70 terminals are open, above terminals.max_open (64): they keep running, and a new one opens once 7 of them have closed",
                "terminals.max_open (64) is above the machine's 50 PTYs: the machine's own limit is reached first",
            ]
        );
    }

    #[test]
    fn says_nothing_at_start_at_or_under_the_budget_on_a_machine_with_room_for_it() {
        assert_eq!(
            budget(3, roomy()).budget.startup_warnings(3),
            Vec::<String>::new()
        );
    }

    #[test]
    fn reports_the_count_the_budget_and_the_machine_for_doctor_the_machine_null_when_unread() {
        assert_eq!(
            [
                budget(3, roomy()).budget.report(counts(2, 0)),
                budget(3, Ptys::Unread("x".to_owned()))
                    .budget
                    .report(counts(1, 0)),
            ],
            [
                Terminals {
                    open: 2,
                    max: 3,
                    host: Some(HostPtys {
                        used: 10,
                        max: 4096,
                        exact: true
                    }),
                    refusing: None,
                },
                Terminals {
                    open: 1,
                    max: 3,
                    host: None,
                    refusing: None,
                },
            ]
        );
    }

    #[test]
    fn reports_which_limit_refuses_new_terminals_the_budget_an_exactly_counted_machine_or_none() {
        let short = host_headroom(511) - 1;
        let refusing = [
            budget(2, roomy()).budget.report(counts(2, 0)),
            budget(3, leaving(short, true)).budget.report(counts(0, 0)),
            budget(3, leaving(short, false)).budget.report(counts(0, 0)),
        ]
        .map(|r| r.refusing);
        assert_eq!(
            refusing,
            [Some(Refusing::Budget), Some(Refusing::Host), None]
        );
    }
}

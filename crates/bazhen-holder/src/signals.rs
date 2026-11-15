use libc::c_int;

/// The standard signals both Linux and macOS define, by name: their numbers differ between the
/// two (`SIGSYS` is 31 on Linux and 12 on macOS), so code never assumes a range of them.
pub(crate) const NAMED: [(c_int, &str); 29] = [
    (libc::SIGHUP, "SIGHUP"),
    (libc::SIGINT, "SIGINT"),
    (libc::SIGQUIT, "SIGQUIT"),
    (libc::SIGILL, "SIGILL"),
    (libc::SIGTRAP, "SIGTRAP"),
    (libc::SIGABRT, "SIGABRT"),
    (libc::SIGBUS, "SIGBUS"),
    (libc::SIGFPE, "SIGFPE"),
    (libc::SIGKILL, "SIGKILL"),
    (libc::SIGUSR1, "SIGUSR1"),
    (libc::SIGSEGV, "SIGSEGV"),
    (libc::SIGUSR2, "SIGUSR2"),
    (libc::SIGPIPE, "SIGPIPE"),
    (libc::SIGALRM, "SIGALRM"),
    (libc::SIGTERM, "SIGTERM"),
    (libc::SIGCHLD, "SIGCHLD"),
    (libc::SIGCONT, "SIGCONT"),
    (libc::SIGSTOP, "SIGSTOP"),
    (libc::SIGTSTP, "SIGTSTP"),
    (libc::SIGTTIN, "SIGTTIN"),
    (libc::SIGTTOU, "SIGTTOU"),
    (libc::SIGURG, "SIGURG"),
    (libc::SIGXCPU, "SIGXCPU"),
    (libc::SIGXFSZ, "SIGXFSZ"),
    (libc::SIGVTALRM, "SIGVTALRM"),
    (libc::SIGPROF, "SIGPROF"),
    (libc::SIGWINCH, "SIGWINCH"),
    (libc::SIGIO, "SIGIO"),
    (libc::SIGSYS, "SIGSYS"),
];

/// Whether a disposition can be set for `signal`: every signal but `SIGKILL` and `SIGSTOP`.
pub(crate) const fn catchable(signal: c_int) -> bool {
    signal != libc::SIGKILL && signal != libc::SIGSTOP
}

/// `SIGTERM` for 15, or `SIG40` for a number no name here covers, such as a real-time signal.
pub(crate) fn name(signal: c_int) -> String {
    NAMED
        .iter()
        .find(|(number, _)| *number == signal)
        .map_or_else(|| format!("SIG{signal}"), |(_, name)| (*name).to_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_a_signal_by_its_number_on_this_os() {
        assert_eq!(name(libc::SIGTERM), "SIGTERM");
        assert_eq!(name(libc::SIGUSR1), "SIGUSR1");
        assert_eq!(name(libc::SIGWINCH), "SIGWINCH");
    }

    #[test]
    fn names_a_number_it_has_no_name_for_by_the_number() {
        assert_eq!(name(64), "SIG64");
    }

    #[test]
    fn every_name_is_listed_once() {
        for (i, (number, name)) in NAMED.iter().enumerate() {
            assert!(
                NAMED
                    .iter()
                    .skip(i + 1)
                    .all(|(n, s)| n != number && s != name),
                "{name} is listed twice"
            );
        }
    }

    #[test]
    fn only_kill_and_stop_are_not_catchable() {
        let fixed: Vec<_> = NAMED.iter().filter(|(n, _)| !catchable(*n)).collect();
        assert_eq!(
            fixed,
            [&(libc::SIGKILL, "SIGKILL"), &(libc::SIGSTOP, "SIGSTOP")]
        );
    }
}

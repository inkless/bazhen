//! The descriptors the daemon may have open: its soft limit raised as it starts, as far as is safe
//! for what inherits it. The socket's connections are sized to what it then has.

use rustix::process::{Resource, Rlimit, getrlimit, setrlimit};

/// The soft limit the daemon raises its own to, under its hard limit: room for the most
/// connections the socket serves, and no more, as every holder and agent it starts inherits it.
/// Below macOS's `OPEN_MAX` (10240), past which an infinite hard limit can't be met.
const RAISED: u64 = 8192;

/// The soft limit to raise to from `soft`, under `hard`, `None` for each meaning infinite: none
/// when `soft` is that high already, as a limit is never lowered.
fn target(soft: Option<u64>, hard: Option<u64>) -> Option<u64> {
    let to = hard.map_or(RAISED, |hard| hard.min(RAISED));
    soft.filter(|&soft| soft < to).map(|_| to)
}

/// Raises the soft limit as [`target`] says, and reads it again after: what the daemon has, `None`
/// for infinite. A raise refused is said, and the daemon serves with what it has.
pub(crate) fn raise() -> Option<u64> {
    let Rlimit { current, maximum } = getrlimit(Resource::Nofile);
    if let Some(to) = target(current, maximum) {
        let raised = Rlimit {
            current: Some(to),
            maximum,
        };
        if let Err(err) = setrlimit(Resource::Nofile, raised) {
            tracing::warn!(
                "bazhen can't raise its open-file limit from {} to {to}: {err}",
                current.map_or_else(|| "unlimited".to_owned(), |soft| soft.to_string())
            );
        }
    }
    getrlimit(Resource::Nofile).current
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn raises_to_its_cap_under_an_infinite_or_a_higher_hard_limit() {
        assert_eq!(target(Some(256), None), Some(RAISED));
        assert_eq!(target(Some(1024), Some(1 << 20)), Some(RAISED));
    }

    #[test]
    fn raises_no_higher_than_a_hard_limit_below_its_cap() {
        assert_eq!(target(Some(256), Some(4096)), Some(4096));
        assert_eq!(target(Some(4096), Some(4096)), None);
    }

    #[test]
    fn never_lowers_a_soft_limit_already_as_high() {
        assert_eq!(target(Some(RAISED), None), None);
        assert_eq!(target(Some(65_536), Some(1 << 20)), None);
        assert_eq!(target(Some(5000), Some(4096)), None);
        assert_eq!(target(None, None), None);
    }
}

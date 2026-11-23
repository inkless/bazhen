//! SIGCHLD's disposition, which decides whether the kernel keeps an exited child for its parent
//! to wait for. Ignored, or with `SA_NOCLDWAIT`, it reaps each child itself as it exits, and the
//! child's pid is free at once: a `Child` that names it, or a group it led, may then be another
//! process's. A process inherits an ignored SIGCHLD from whatever started it, across `exec`.

use std::io;

use crate::sys;

/// Makes the kernel keep each exited child until it is waited for: an ignored SIGCHLD gets its
/// default, and `SA_NOCLDWAIT` is dropped. A handler already set, such as tokio's, which its
/// `Child::wait` needs, is kept as it is, with its mask and its other flags. A daemon calls it
/// before it starts any child.
///
/// # Errors
///
/// When the kernel won't say what SIGCHLD does, or refuses the change.
pub fn keep_exited_children() -> io::Result<()> {
    let mut action = sys::sigchld()?;
    let ignored = action.ignored();
    if !ignored && !action.no_child_wait() {
        return Ok(());
    }
    if ignored {
        action = action.defaulted();
    }
    sys::set_sigchld(action.without_no_child_wait())
}

/// Whether the kernel keeps an exited child until it is waited for: SIGCHLD isn't ignored and
/// has no `SA_NOCLDWAIT`.
///
/// # Errors
///
/// When the kernel won't say.
pub fn children_kept() -> io::Result<bool> {
    let action = sys::sigchld()?;
    Ok(!action.ignored() && !action.no_child_wait())
}

/// How a test leaves SIGCHLD before it calls `keep_exited_children`, as a careless parent could,
/// or as a runtime that set its own handler first does.
#[cfg(test)]
#[derive(Debug, Clone, Copy)]
enum Careless {
    Ignored,
    NoChildWait,
    Handled,
    HandledNoChildWait,
}

/// Leaves SIGCHLD as `careless` says, for a test, which nextest runs in a process of its own.
#[cfg(test)]
fn make_careless(careless: Careless) -> io::Result<()> {
    use sys::TestHandler::{Default, Ignore, Nothing};
    match careless {
        Careless::Ignored => sys::set_sigchld_for_test(Ignore, false),
        Careless::NoChildWait => sys::set_sigchld_for_test(Default, true),
        Careless::Handled => sys::set_sigchld_for_test(Nothing, false),
        Careless::HandledNoChildWait => sys::set_sigchld_for_test(Nothing, true),
    }
}

/// Whether SIGCHLD's handler is the one `make_careless` sets.
#[cfg(test)]
fn handled() -> io::Result<bool> {
    Ok(sys::sigchld()?.handled())
}

#[cfg(test)]
mod tests {
    use super::{Careless, children_kept, handled, keep_exited_children, make_careless};

    /// A handler already set, as tokio's is once a runtime waits on a child, is what its
    /// `Child::wait` hears an exit by: replaced, every wait would hang.
    #[test]
    fn keeps_a_handler_already_set_for_sigchld() {
        make_careless(Careless::Handled).unwrap();
        keep_exited_children().unwrap();
        assert_eq!((handled().unwrap(), children_kept().unwrap()), (true, true));
    }

    #[test]
    fn keeps_a_handler_already_set_for_sigchld_but_drops_its_no_child_wait() {
        make_careless(Careless::HandledNoChildWait).unwrap();
        assert!(!children_kept().unwrap());
        keep_exited_children().unwrap();
        assert_eq!((handled().unwrap(), children_kept().unwrap()), (true, true));
    }

    /// SIGCHLD's disposition is this test process's own, which nextest runs alone.
    #[test]
    fn keeps_exited_children_once_given_its_default_after_a_parent_ignored_sigchld() {
        make_careless(Careless::Ignored).unwrap();
        assert!(!children_kept().unwrap());
        keep_exited_children().unwrap();
        assert!(children_kept().unwrap());
    }

    #[test]
    fn keeps_exited_children_once_given_its_default_after_a_parent_set_no_child_wait() {
        make_careless(Careless::NoChildWait).unwrap();
        assert!(!children_kept().unwrap());
        keep_exited_children().unwrap();
        assert!(children_kept().unwrap());
    }
}

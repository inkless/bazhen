//! `ended_within` and `end_within`: a child waited for is left unreaped until its owner reaps
//! it, so a signal sent at the bound reaches only that child. While the kernel reaps children
//! itself, neither waits at all.

use std::os::unix::process::ExitStatusExt as _;
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use bazhen_test_signal::{
    ChildrenNotKept, Signal, end_within, ended_within, in_sigchld_ignored_run,
    rerun_with_sigchld_ignored,
};
use rustix::process::{Pid, WaitId, WaitIdOptions, waitid};

const BOUND: Duration = Duration::from_secs(10);
/// Far shorter than a `sleep 30` takes to end.
const SHORT: Duration = Duration::from_millis(200);

fn exiting_with(code: u8) -> std::io::Result<Child> {
    Command::new("sh")
        .args(["-c", &format!("exit {code}")])
        .stdin(Stdio::null())
        .spawn()
}

fn sleeping() -> std::io::Result<Child> {
    Command::new("sleep").arg("30").stdin(Stdio::null()).spawn()
}

/// Outlasts `SHORT`, and ends by itself, so no test signals it.
fn outlasting_short() -> std::io::Result<Child> {
    Command::new("sleep").arg("2").stdin(Stdio::null()).spawn()
}

/// Whether `waited` is the refusal to wait while the kernel reaps children itself.
fn refused<T>(waited: &std::io::Result<T>) -> bool {
    let Err(error) = waited else {
        return false;
    };
    let Some(inner) = error.get_ref() else {
        return false;
    };
    inner.is::<ChildrenNotKept>()
}

/// Waits for `child` to end, and whether the wait went as an ignored SIGCHLD has it go. Linux
/// reaps the child itself as it ends, so the wait finds no child left, which shows the kernel did.
/// macOS keeps it for its parent's wait.
fn waited_as_an_ignored_sigchld_has_it(child: &mut Child) -> bool {
    let waited = child.wait().map(|_| ()).map_err(|e| e.raw_os_error());
    #[cfg(target_os = "linux")]
    let expected = Err(Some(rustix::io::Errno::CHILD.raw_os_error()));
    #[cfg(target_os = "macos")]
    let expected = Ok(());
    waited == expected
}

/// Whether `child` has ended and is still there to reap.
fn unreaped_and_ended(child: &Child) -> bool {
    let found = waitid(
        WaitId::Pid(Pid::from_child(child)),
        WaitIdOptions::EXITED | WaitIdOptions::NOHANG | WaitIdOptions::NOWAIT,
    );
    matches!(found, Ok(Some(_)))
}

#[test]
fn leaves_a_child_that_ended_for_its_owner_to_reap() {
    let mut child = exiting_with(3).unwrap();
    assert!(ended_within(&child, BOUND).unwrap());
    assert!(unreaped_and_ended(&child), "the wait reaped the child");
    assert_eq!(child.wait().unwrap().code(), Some(3));
}

#[test]
fn leaves_a_child_still_running_at_the_bound_running() {
    let mut child = Command::new("cat")
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .spawn()
        .unwrap();
    assert!(!ended_within(&child, SHORT).unwrap());
    assert!(child.try_wait().unwrap().is_none());
    // `cat` ends at the end of its input, so it ends with no signal.
    drop(child.stdin.take());
    assert!(ended_within(&child, BOUND).unwrap());
    assert_eq!(child.wait().unwrap().code(), Some(0));
}

#[test]
fn counts_a_child_its_owner_already_reaped_as_ended() {
    let mut child = exiting_with(0).unwrap();
    child.wait().unwrap();
    assert_eq!(ended_within(&child, BOUND).map_err(|e| e.kind()), Ok(true));
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn ends_with_how_a_child_that_ended_within_the_bound_exited() {
    bazhen_test_signal::require_sandbox().unwrap();
    let mut child = exiting_with(3).unwrap();
    let ended = end_within(&mut child, BOUND).unwrap();
    assert_eq!(ended.map(|status| status.code()), Some(Some(3)));
}

#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn kills_and_reaps_a_child_still_running_at_the_bound() {
    bazhen_test_signal::require_sandbox().unwrap();
    let mut child = sleeping().unwrap();
    assert_eq!(end_within(&mut child, SHORT).unwrap(), None);
    // std keeps the status it reaped, so this reads it rather than waiting again.
    let reaped = child.try_wait().unwrap();
    assert_eq!(
        reaped.and_then(|status| status.signal()),
        Some(Signal::KILL.as_raw())
    );
}

/// SIGCHLD ignored, the kernel may reap the child as it ends, as Linux does, and its pid could be
/// another process's by the bound. The test runs itself again under a parent that ignored it.
#[test]
fn refuses_to_watch_a_child_while_sigchld_is_ignored() {
    if !in_sigchld_ignored_run() {
        assert!(bazhen_pid::children_kept().unwrap());
        rerun_with_sigchld_ignored("refuses_to_watch_a_child_while_sigchld_is_ignored", false)
            .unwrap();
        return;
    }
    assert!(
        !bazhen_pid::children_kept().unwrap(),
        "the run left SIGCHLD kept"
    );
    let mut child = outlasting_short().unwrap();
    let waited = ended_within(&child, SHORT);
    assert!(refused(&waited), "{waited:?}");
    assert!(waited_as_an_ignored_sigchld_has_it(&mut child));
}

/// Refused before the child is waited for or sent anything, as a KILL at the bound could reach
/// another process.
#[test]
#[ignore = "signals processes; runs in moon run :test-real -- rust"]
fn refuses_to_end_a_child_while_sigchld_is_ignored() {
    bazhen_test_signal::require_sandbox().unwrap();
    if !in_sigchld_ignored_run() {
        assert!(bazhen_pid::children_kept().unwrap());
        rerun_with_sigchld_ignored("refuses_to_end_a_child_while_sigchld_is_ignored", true)
            .unwrap();
        return;
    }
    assert!(
        !bazhen_pid::children_kept().unwrap(),
        "the run left SIGCHLD kept"
    );
    let mut child = outlasting_short().unwrap();
    let ended = end_within(&mut child, SHORT);
    assert!(refused(&ended), "{ended:?}");
    assert!(waited_as_an_ignored_sigchld_has_it(&mut child));
}

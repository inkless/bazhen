//! Running a test again in a process whose SIGCHLD is ignored, as a parent that ignored it leaves
//! every process it starts. perl ignores it before it execs the test, and exec keeps an ignored
//! signal ignored. A shell can't stand in: dash's `trap '' CHLD` leaves SIGCHLD at its default.

use std::io;
use std::process::Command;

/// Set in the run inside, so the test knows it is that run.
const RUN: &str = "BAZHEN_TEST_SIGCHLD_IGNORED_RUN";

const IGNORE_THEN_EXEC: &str =
    r#"$SIG{CHLD} = "IGNORE"; exec { $ARGV[0] } @ARGV or die "exec: $!";"#;

/// Why a test run again with SIGCHLD ignored didn't pass.
#[derive(Debug, thiserror::Error)]
pub enum RerunFailed {
    #[error("starting the run with SIGCHLD ignored: {0}")]
    Start(#[source] io::Error),
    #[error("the run with SIGCHLD ignored failed: {0}")]
    Failed(String),
    #[error("the run with SIGCHLD ignored ran no test named {test}: {output}")]
    NotRun { test: String, output: String },
}

/// Whether this process is a run `rerun_with_sigchld_ignored` started.
pub fn in_sigchld_ignored_run() -> bool {
    std::env::var_os(RUN).is_some()
}

/// Runs `test`, this test binary's test of that exact name, again in a process of its own whose
/// SIGCHLD is ignored. `ignored` says the test is one marked `#[ignore]`. The run inside reads
/// `in_sigchld_ignored_run` as true, and should check that SIGCHLD is ignored before anything
/// else, so a run that failed to ignore it fails rather than passes.
///
/// # Errors
///
/// When the run can't start, fails, or runs no test of that name.
pub fn rerun_with_sigchld_ignored(test: &str, ignored: bool) -> Result<(), RerunFailed> {
    let binary = std::env::current_exe().map_err(RerunFailed::Start)?;
    let mut run = Command::new("perl");
    run.args(["-e", IGNORE_THEN_EXEC])
        .arg(binary)
        .args(["--exact", test, "--nocapture"])
        .env(RUN, "1");
    if ignored {
        run.arg("--ignored");
    }
    let ran = run.output().map_err(RerunFailed::Start)?;
    let output = format!(
        "{}{}",
        String::from_utf8_lossy(&ran.stdout),
        String::from_utf8_lossy(&ran.stderr)
    );
    if !ran.status.success() {
        return Err(RerunFailed::Failed(output));
    }
    if !output.contains(" 1 passed;") {
        return Err(RerunFailed::NotRun {
            test: test.to_owned(),
            output,
        });
    }
    Ok(())
}

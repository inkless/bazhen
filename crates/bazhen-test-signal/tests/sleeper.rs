//! The sleeper the holder tests copy under a holder's name. Being an integration test of this
//! crate, this also has cargo build the sleeper wherever the workspace's tests are built: a bin
//! no test of its own package needs is built only as a test harness.

use std::process::Command;
use std::time::{Duration, Instant};

const SLEEPER: &str = env!("CARGO_BIN_EXE_bazhen-test-sleeper");

#[test]
fn sleeps_the_seconds_it_is_given_and_says_nothing() {
    let started = Instant::now();
    let out = Command::new(SLEEPER).arg("1").output().unwrap();
    let slept = started.elapsed();
    assert_eq!(
        (
            out.status.code(),
            out.stdout.as_slice(),
            out.stderr.as_slice()
        ),
        (Some(0), &b""[..], &b""[..])
    );
    assert!(slept >= Duration::from_secs(1), "slept {slept:?}");
}

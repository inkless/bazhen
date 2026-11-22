//! Sleeps for the seconds its one argument gives, 10 without one, and says nothing: a process of
//! the tests' own build that a test copies under a holder's name to stand in for one. A system
//! `sleep` can't: one that is a multicall coreutils chooses what to run by its own file's name,
//! and under the holder's runs nothing.

use std::time::Duration;

fn main() {
    let seconds = std::env::args()
        .nth(1)
        .and_then(|arg| arg.parse().ok())
        .unwrap_or(10);
    std::thread::sleep(Duration::from_secs(seconds));
}

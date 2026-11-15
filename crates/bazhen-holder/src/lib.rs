//! `bazhen-holder`: the process that holds one terminal. It owns the terminal's PTY and runs its
//! child as the leader of a session of its own, reaps that child and keeps its exact status, and
//! ends it on close. The daemon starts one per terminal, and each outlives the daemon.
//!
//! Synchronous and single-threaded: one `poll` loop, no async runtime.

pub mod child;
pub mod conn;
pub mod holder;
pub mod log;
#[cfg(target_os = "macos")]
mod macos;
pub mod pty;
pub mod ring;
mod signals;
pub mod socket;
pub mod start;
pub mod start_time;

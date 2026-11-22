//! The Rust daemon: it owns a home's terminals and serves the API on the home's Unix socket and on
//! loopback HTTP, as `apps/daemon` does, which it is to replace.

mod accept;
mod callers;
pub mod config;
mod detach;
mod devices;
mod env;
mod events;
mod guard;
mod heartbeat;
mod lock;
mod log;
mod paired;
mod pairing;
mod peer;
mod private_dir;
mod probe;
mod retention;
mod routes;
mod run;
mod serve;
mod session;
pub mod tasks;
#[cfg(test)]
mod testing;
mod tokens;
mod writer;

pub use run::run;

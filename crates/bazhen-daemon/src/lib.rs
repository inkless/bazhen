//! The Rust daemon: it owns a home's terminals and serves the API on the home's Unix socket and on
//! loopback HTTP, as `apps/daemon` does, which it is to replace.

mod accept;
pub mod config;
mod detach;
mod env;
mod events;
mod guard;
mod heartbeat;
mod log;
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
mod writer;

pub use run::run;

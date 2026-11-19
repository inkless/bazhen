//! The Rust daemon: it owns a home's terminals and serves the API on the home's Unix socket and on
//! loopback HTTP, as `apps/daemon` does, which it is to replace.

mod accept;
pub mod config;
mod detach;
mod env;
mod guard;
mod log;
mod private_dir;
mod probe;
mod retention;
mod routes;
mod run;
mod serve;
mod session;
#[cfg(test)]
mod testing;
mod writer;

pub use run::run;

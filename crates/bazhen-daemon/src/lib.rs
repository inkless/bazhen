//! The Rust daemon: it owns a home's terminals and serves the API on the home's Unix socket and on
//! loopback HTTP, as `apps/daemon` does, which it is to replace.

pub mod config;
mod detach;
mod env;
mod guard;
mod log;
mod private_dir;
mod probe;
mod routes;
mod run;
mod serve;

pub use run::run;

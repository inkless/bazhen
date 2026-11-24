//! The Rust daemon: it owns a home's terminals and serves the API on the home's Unix socket and on
//! loopback HTTP, as `apps/daemon` does, which it is to replace.

mod accept;
mod agent_cli;
mod budget;
mod callers;
mod channel;
pub mod config;
mod detach;
mod devices;
mod doctor;
mod env;
mod events;
mod guard;
mod heartbeat;
mod holder;
mod hook_link;
mod lock;
mod log;
mod paired;
mod pairing;
mod peer;
mod private_dir;
mod probe;
mod restarts;
mod retention;
mod roles;
mod routes;
mod run;
mod runner;
mod serve;
mod session;
mod shell_routes;
mod shells;
mod stream;
pub mod tasks;
mod terminal_routes;
mod terminals;
#[cfg(test)]
mod testing;
mod tokens;
mod web;
mod writer;

pub use channel::rpc;
pub use run::run;
pub use stream::said;

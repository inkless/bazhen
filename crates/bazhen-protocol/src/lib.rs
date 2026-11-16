//! The daemon's API messages, as the Rust CLI sends and reads them: serde types held to the
//! fixtures `pnpm schema` writes from the TypeScript protocol (packages/protocol), and the checks a
//! client makes before it asks the daemon. No I/O.

pub mod agents;
pub mod daemon;
pub mod id;
pub mod ids;
pub mod mail;
pub mod names;
pub mod notices;
pub mod nullable;
pub mod record;
pub mod roles;
pub mod shells;
pub mod tasks;
pub mod text;
pub mod time;
pub mod wire;

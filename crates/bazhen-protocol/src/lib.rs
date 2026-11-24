//! The daemon's API messages, as the Rust CLI sends and reads them: serde types held to the
//! fixtures `moon run :schema` writes from the TypeScript protocol (packages/protocol), and the
//! checks a client makes before it asks the daemon. No I/O.

pub mod agents;
pub mod daemon;
pub mod detach_keys;
pub mod events;
pub mod id;
pub mod ids;
pub mod input;
pub mod js_number;
pub mod mail;
pub mod names;
pub mod notices;
pub mod nullable;
pub mod record;
pub mod roles;
pub mod shells;
pub mod stream;
pub mod tasks;
pub mod terminals;
pub mod text;
pub mod time;
pub mod waits;
pub mod wire;

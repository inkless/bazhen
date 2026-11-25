//! The daemon's API messages, as the Rust daemon and CLI send and read them: serde types, held to
//! the fixtures `moon run :schema` writes from the TypeScript protocol (packages/protocol), from
//! which `cargo xtask schema` publishes the protocol's JSON Schema and id; and the checks a client
//! makes before it asks the daemon. No I/O.

pub mod agent_events;
pub mod agents;
pub mod daemon;
pub mod detach_keys;
pub mod edge;
pub mod events;
pub mod id;
pub mod ids;
pub mod input;
pub mod js_number;
pub mod mail;
pub mod mail_events;
pub mod names;
pub mod notices;
pub mod nullable;
pub mod record;
pub mod roles;
#[cfg(feature = "schema")]
pub mod schema;
pub mod semantics;
pub mod shells;
pub mod stream;
pub mod task_events;
pub mod tasks;
pub mod terminals;
pub mod text;
pub mod time;
pub mod waits;
pub mod wire;

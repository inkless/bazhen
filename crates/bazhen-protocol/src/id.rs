//! The protocol this build speaks, as `protocolId()` in packages/protocol/src/id.ts hashes it.
//! Written by `moon run :schema`, and held to it by `moon run :schema -- --check`: don't edit it by hand.

/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\0content\0` in
/// name order. A daemon that answers with another is another build, to restart.
pub const PROTOCOL_ID: &str = "eeb2358e54c3c976d028981fd06f79eced5a10732d92b89d4c83f0cb362db6b5";

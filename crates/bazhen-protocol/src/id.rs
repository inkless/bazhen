//! The protocol this build speaks, as `protocolId()` in packages/protocol/src/id.ts hashes it.
//! Written by `moon run :schema`, and held to it by `moon run :schema -- --check`: don't edit it by hand.

/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\0content\0` in
/// name order. A daemon that answers with another is another build, to restart.
pub const PROTOCOL_ID: &str = "91e0650ab155a5d7a4b0d96f980d6fcdeccd785c99bb1c4e2021232aa3eb0681";

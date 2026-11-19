//! The protocol this build speaks, as `protocolId()` in packages/protocol/src/id.ts hashes it.
//! Written by `moon run :schema`, and held to it by `moon run :schema -- --check`: don't edit it by hand.

/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\0content\0` in
/// name order. A daemon that answers with another is another build, to restart.
pub const PROTOCOL_ID: &str = "b7807f3e7f996446a3f6f1fe52bb6a15aa23a459378e10e79b6db4aae5763b0e";

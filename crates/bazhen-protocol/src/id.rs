//! The protocol this build speaks, as `protocolId()` in packages/protocol/src/id.ts hashes it.
//! Written by `pnpm schema`, and held to it by `pnpm schema --check`: don't edit it by hand.

/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\0content\0` in
/// name order. A daemon that answers with another is another build, to restart.
pub const PROTOCOL_ID: &str = "12a4568c51f8edcc2228f8761b15a5fc3b444b5b1dd97c03075828cbfd5bec88";

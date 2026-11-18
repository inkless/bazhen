//! The protocol this build speaks, as `protocolId()` in packages/protocol/src/id.ts hashes it.
//! Written by `pnpm schema`, and held to it by `pnpm schema --check`: don't edit it by hand.

/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\0content\0` in
/// name order. A daemon that answers with another is another build, to restart.
pub const PROTOCOL_ID: &str = "a18aa21713d6e8be8fbc54fe633f2924d1c224b34748a034086266c9bacd6cfd";

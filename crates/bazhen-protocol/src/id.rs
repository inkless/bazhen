//! The protocol this build speaks, as `protocolId()` in packages/protocol/src/id.ts hashes it.
//! Written by `pnpm schema`, and held to it by `pnpm schema --check`: don't edit it by hand.

/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\0content\0` in
/// name order. A daemon that answers with another is another build, to restart.
pub const PROTOCOL_ID: &str = "38f0f8289c9ebd5fc193ad093cc97b8396235e9f983becd6a75b1061ba9a8974";

//! The protocol this build speaks. Written by `cargo xtask schema`, and held to it by its
//! `--check`: don't edit it by hand.

/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\0content\0` in
/// name order. A daemon that answers with another is another build, to restart.
pub const PROTOCOL_ID: &str = "826799abff6dfbfbf356aa7a397e9b4bfe3b4b0119b703e424e8f28f6c8a8b06";

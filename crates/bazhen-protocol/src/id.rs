//! The protocol this build speaks. Written by `cargo xtask schema`, and held to it by its
//! `--check`: don't edit it by hand.

/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\0content\0` in
/// name order. A daemon that answers with another is another build, to restart.
pub const PROTOCOL_ID: &str = "6fdbf43953ce0b999d9e110b3060734a97a6f24be8003fec0829d340776589ca";

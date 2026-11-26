//! The protocol this build speaks. Written by `cargo xtask schema`, and held to it by its
//! `--check`: don't edit it by hand.

/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\0content\0` in
/// name order. A daemon that answers with another is another build, to restart.
pub const PROTOCOL_ID: &str = "d68706b72f84196e6e49ba44c7e56fe26fae1aedbd49cfc8913668d7c9126315";

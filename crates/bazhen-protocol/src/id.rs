//! The protocol this build speaks. Written by `cargo xtask schema`, and held to it by its
//! `--check`: don't edit it by hand.

/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\0content\0` in
/// name order. A daemon that answers with another is another build, to restart.
pub const PROTOCOL_ID: &str = "5945991c2f43816e8007c69f0e42bb37a10db2df23805ad285b51337fba03043";

//! The protocol this build speaks. Written by `cargo xtask schema`, and held to it by its
//! `--check`: don't edit it by hand.

/// The SHA-256, in hex, of every file in packages/protocol/schema/, each `name\0content\0` in
/// name order. A daemon that answers with another is another build, to restart.
pub const PROTOCOL_ID: &str = "f9dd5a6bcde1272b9c0d0137e4f55e563591edd728e0cb49040d6c539bb9c507";

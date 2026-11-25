//! What the protocol means beyond what its JSON Schema can say. `cargo xtask schema` publishes it
//! as `packages/protocol/schema/semantics.json`, so it counts toward the protocol id.
//!
//! `constants` (`HISTORY_LINES`, `STREAM_FRAME_MAX_BYTES`, `EVENT_FRAME_MAX_BYTES`) are the values
//! a client and the daemon must agree on that no schema shows, so changing one changes the id by
//! itself. For anything else a schema can't say, such as a refinement, a route, or what the daemon
//! does with a message, bump `REVISION` and say why in `REASON`, in the change that alters it in a
//! way a client of the build before would misread.

/// How many times the protocol has changed in a way its schema doesn't show.
pub const REVISION: u32 = 2;

/// Why `REVISION` last moved.
pub const REASON: &str = "A holder view gets no screen frame: its own bytes carry the switch, and a page that read the frame alone would route the wheel as if on the main screen.";

//! A terminal's screen, read as text.

use serde::{Deserialize, Serialize};

/// The most rows of history a screen read may ask for (`SCREEN_HISTORY_MAX`).
pub const SCREEN_HISTORY_MAX: u32 = 10_000;

/// `GET /v1/terminals/:id/screen`: the newest rows of history asked for, then the screen shown,
/// a line a row, each ended by `\n`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TerminalScreen {
    /// No control but the newline ending each row, as the daemon sends it.
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::ScreenText"))]
    pub text: String,
    /// How many of its rows are history.
    pub history: u64,
}

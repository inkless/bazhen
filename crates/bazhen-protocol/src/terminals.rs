//! A terminal's screen, read as text.

use serde::{Deserialize, Serialize};

/// `GET /v1/terminals/:id/screen`: the newest rows of history asked for, then the screen shown,
/// a line a row, each ended by `\n`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalScreen {
    /// No control but the newline ending each row, as the daemon sends it.
    pub text: String,
    /// How many of its rows are history.
    pub history: u64,
}

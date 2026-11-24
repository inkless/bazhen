//! What starting a harness's TUI takes and gives.

use bazhen_protocol::agents::ExternalRefKind;
use bazhen_protocol::shells::TuiTheme;
use std::fmt;

/// One start of an agent's TUI: where, and what this start asks for beyond the agent's launch.
/// Nothing here is stored (`AgentLaunchRequest` and `LaunchOptions`, in core).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct LaunchRequest {
    /// The directory the TUI starts in.
    pub cwd: String,
    /// The background the TUI is shown on; none, and the user's own setting stands.
    pub theme: Option<TuiTheme>,
    /// Text added to the harness's own system instructions, such as the agent's fleet verbs.
    pub instructions: Option<String>,
    /// A private file holding `instructions`, for a harness that reads them from one.
    pub instructions_file: Option<String>,
    /// Whether `instructions` differ from those the agent's last start gave it, for a harness
    /// whose session keeps what it was first given across a resume.
    pub instructions_changed: bool,
    /// The agent's name at this start, for a harness that shows its session by one.
    pub name: Option<String>,
    /// How many tokens of context the harness compacts at; none, and its own setting stands.
    pub compact_window_tokens: Option<u64>,
}

/// A harness's own session, apart from the environment it runs in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRef {
    pub kind: ExternalRefKind,
    pub id: String,
}

/// How to start a harness's TUI; the daemon turns it into a terminal.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchSpec {
    pub argv: Vec<String>,
    /// The harness's own variables; never a user value.
    pub env: Vec<(String, String)>,
    /// The theme the TUI starts for, when the launch named one: the one asked for, or the one the
    /// harness can draw for if it differs.
    pub theme: Option<TuiTheme>,
    /// The session the launch creates, when it is known before the TUI starts.
    pub session: Option<SessionRef>,
}

/// What the daemon knows of a session, for whether it can be resumed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Evidence<'a> {
    /// Where the session's conversation is kept, as its reports named it.
    pub transcript: Option<&'a str>,
}

/// A harness's refusal of a launch or a resume, such as a server's to load a session.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Refused {
    pub reason: String,
}

impl fmt::Display for Refused {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.reason)
    }
}

impl std::error::Error for Refused {}

//! What starting a harness's TUI takes and gives.

use crate::{ChannelError, ChannelErrorKind};
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

/// Why a launch or a resume didn't happen.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LaunchError {
    /// The harness refused it, as a server refuses a request it can't take: trying it again as it
    /// is won't help.
    Refused(String),
    /// The harness couldn't be reached, or it failed some other way.
    Unavailable(String),
}

impl From<ChannelError> for LaunchError {
    fn from(error: ChannelError) -> Self {
        match error.kind {
            ChannelErrorKind::Refused => Self::Refused(error.message),
            ChannelErrorKind::Failed => Self::Unavailable(error.message),
        }
    }
}

impl fmt::Display for LaunchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Refused(reason) | Self::Unavailable(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for LaunchError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn takes_a_channels_refusal_for_a_refused_launch_and_any_other_error_for_an_unavailable_one() {
        let error = |kind| ChannelError {
            kind,
            message: "no such thread".to_owned(),
        };
        let launch = |kind| LaunchError::from(error(kind));
        assert_eq!(
            [
                launch(ChannelErrorKind::Refused),
                launch(ChannelErrorKind::Failed)
            ],
            [
                LaunchError::Refused("no such thread".to_owned()),
                LaunchError::Unavailable("no such thread".to_owned()),
            ]
        );
        assert_eq!(
            [
                launch(ChannelErrorKind::Refused).to_string(),
                launch(ChannelErrorKind::Failed).to_string()
            ],
            ["no such thread", "no such thread"]
        );
    }
}

//! Shells, and what agents and shells share: the theme a terminal is drawn in, and the restart a
//! terminal on an older holder needs.

use serde::{Deserialize, Serialize};

use crate::ids::{AgentId, EnvironmentId, TerminalId};

/// Light or dark: the background a TUI is started for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TuiTheme {
    Light,
    Dark,
}

/// Set while a terminal runs on a holder this build can't fully serve.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedsRestart {
    pub holder_pid: Option<u64>,
    #[serde(default)]
    pub served: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum TerminalState {
    Creating,
    Running,
    Exited,
    Unknown,
    Lost,
    Closing,
    Closed,
    Failed,
}

impl TerminalState {
    /// Closed or failed: it will run nothing again.
    pub fn ended(self) -> bool {
        matches!(self, Self::Closed | Self::Failed)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Creating => "creating",
            Self::Running => "running",
            Self::Exited => "exited",
            Self::Unknown => "unknown",
            Self::Lost => "lost",
            Self::Closing => "closing",
            Self::Closed => "closed",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShellCommand {
    Close,
    Restart,
    Rename,
    Unlink,
}

/// A program the user was shown running in a shell, and chose to end with it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BusyShell {
    pub terminal_id: TerminalId,
    pub program: String,
}

/// The program a shell runs in its foreground, and since when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Foreground {
    pub command: String,
    pub since: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Shell {
    pub id: TerminalId,
    pub environment_id: EnvironmentId,
    pub state: TerminalState,
    pub generation: u64,
    pub cwd: String,
    pub linked_agent_id: Option<AgentId>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub foreground: Option<Foreground>,
    pub theme: TuiTheme,
    pub attach_command: Option<String>,
    pub commands: Vec<ShellCommand>,
    #[serde(default)]
    pub retypeable: bool,
    #[serde(default)]
    pub needs_restart: Option<NeedsRestart>,
}

/// `POST /v1/shells`: a shell beside an agent, in its directory, or a shell of its own in `cwd`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenShellRequest {
    pub idempotency_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub linked_agent_id: Option<AgentId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<TuiTheme>,
}

/// `POST /v1/shells/:id/close`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseShellRequest {
    pub idempotency_key: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_busy: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_program: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
}

/// What a command on a shell produced: the shell it was on, and the events it recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCommandResponse {
    pub terminal_id: TerminalId,
    pub event_ids: Vec<u64>,
}

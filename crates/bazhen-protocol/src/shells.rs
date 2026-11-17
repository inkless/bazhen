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

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

impl TuiTheme {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }

    /// The theme `text` names, as a row records it.
    pub fn parse(text: &str) -> Option<Self> {
        [Self::Light, Self::Dark]
            .into_iter()
            .find(|theme| theme.as_str() == text)
    }
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
    /// The state `text` names, as a row records it.
    pub fn parse(text: &str) -> Option<Self> {
        [
            Self::Creating,
            Self::Running,
            Self::Exited,
            Self::Unknown,
            Self::Lost,
            Self::Closing,
            Self::Closed,
            Self::Failed,
        ]
        .into_iter()
        .find(|state| state.as_str() == text)
    }

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

/// What can be done about a shell in `state`, linked to an agent or not, in the order a client
/// shows it, as `shellCommands` in the TypeScript store has it: what the snapshot offers is what
/// a command accepts.
pub fn shell_commands(state: TerminalState, linked: bool) -> Vec<ShellCommand> {
    use TerminalState::{Closing, Creating, Lost, Running};
    let closable = matches!(state, Running | Lost | Closing);
    let listed = matches!(state, Running | Lost | Closing | Creating);
    [
        (closable, ShellCommand::Close),
        (state == Lost, ShellCommand::Restart),
        (listed, ShellCommand::Rename),
        (linked && state == Running, ShellCommand::Unlink),
    ]
    .into_iter()
    .filter_map(|(offered, command)| offered.then_some(command))
    .collect()
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
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub linked_agent_id: Option<AgentId>,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub cwd: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub theme: Option<TuiTheme>,
}

/// `POST /v1/shells/:id/close`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseShellRequest {
    pub idempotency_key: String,
    pub generation: u64,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub confirm_busy: Option<bool>,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub confirmed_program: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub force: Option<bool>,
}

/// What a command on a shell produced: the shell it was on, and the events it recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellCommandResponse {
    pub terminal_id: TerminalId,
    pub event_ids: Vec<u64>,
}

/// `POST /v1/shells/:id/restart`: a new shell in a lost one's place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestartShellRequest {
    pub idempotency_key: String,
    pub generation: u64,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub theme: Option<TuiTheme>,
    /// Type the lost shell's last line at the new shell's first prompt; only ever `true`.
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    pub retype: Option<bool>,
}

/// `POST /v1/shells/:id/rename`: a name for the shell, or `None` to take it away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameShellRequest {
    pub idempotency_key: String,
    pub name: Option<String>,
}

/// The most UTF-16 units a shell's name has, once trimmed.
pub const SHELL_NAME_MAX_UNITS: usize = 80;

/// A name a person gives a shell, trimmed, if it is 1 to 80 UTF-16 units with no control
/// character or bidirectional override, as `ShellName` in packages/protocol holds it.
pub fn shell_name(text: &str) -> Option<&str> {
    let text = crate::text::trim(text);
    let units = text.encode_utf16().count();
    ((1..=SHELL_NAME_MAX_UNITS).contains(&units) && crate::text::showable(text)).then_some(text)
}

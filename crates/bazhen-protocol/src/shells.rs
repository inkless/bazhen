//! Shells, and what agents and shells share: the theme a terminal is drawn in, and the restart a
//! terminal on an older holder needs.

use serde::{Deserialize, Serialize};

use crate::ids::{AgentId, EnvironmentId, TerminalId};

/// Light or dark: the background a TUI is started for.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct NeedsRestart {
    #[cfg_attr(
        feature = "schema",
        schemars(with = "crate::schema::Required<u64>", range(min = 1))
    )]
    pub holder_pid: Option<u64>,
    #[serde(default)]
    pub served: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
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
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct BusyShell {
    pub terminal_id: TerminalId,
    #[cfg_attr(feature = "schema", schemars(length(max = 200)))]
    pub program: String,
}

/// The program a shell runs in its foreground, and since when.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct Foreground {
    pub command: String,
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::Timestamp"))]
    pub since: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Shell {
    pub id: TerminalId,
    pub environment_id: EnvironmentId,
    pub state: TerminalState,
    pub generation: u64,
    pub cwd: String,
    #[cfg_attr(
        feature = "schema",
        schemars(with = "crate::schema::Required<AgentId>")
    )]
    pub linked_agent_id: Option<AgentId>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub foreground: Option<Foreground>,
    pub theme: TuiTheme,
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::Required<String>"))]
    pub attach_command: Option<String>,
    pub commands: Vec<ShellCommand>,
    #[serde(default)]
    pub retypeable: bool,
    #[serde(default)]
    pub needs_restart: Option<NeedsRestart>,
}

/// `POST /v1/shells`: a shell beside an agent, in its directory, or a shell of its own in `cwd`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[cfg_attr(feature = "schema", schemars(extend("x-bazhen-check" = "linkedShellTakesNoCwd")))]
#[serde(rename_all = "camelCase")]
pub struct OpenShellRequest {
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::IdempotencyKey"))]
    pub idempotency_key: String,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "AgentId"))]
    pub linked_agent_id: Option<AgentId>,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "String", length(min = 1)))]
    pub cwd: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "TuiTheme"))]
    pub theme: Option<TuiTheme>,
}

/// `POST /v1/shells/:id/close`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct CloseShellRequest {
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::IdempotencyKey"))]
    pub idempotency_key: String,
    #[serde(deserialize_with = "crate::js_number::whole")]
    pub generation: u64,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "bool"))]
    pub confirm_busy: Option<bool>,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "String", length(max = 200)))]
    pub confirmed_program: Option<String>,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "bool"))]
    pub force: Option<bool>,
}

/// What a command on a shell produced: the shell it was on, and the events it recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct ShellCommandResponse {
    pub terminal_id: TerminalId,
    #[cfg_attr(feature = "schema", schemars(with = "Vec<crate::schema::EventId>"))]
    pub event_ids: Vec<u64>,
}

/// `POST /v1/shells/:id/restart`: a new shell in a lost one's place.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RestartShellRequest {
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::IdempotencyKey"))]
    pub idempotency_key: String,
    #[serde(deserialize_with = "crate::js_number::whole")]
    pub generation: u64,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "TuiTheme"))]
    pub theme: Option<TuiTheme>,
    /// Type the lost shell's last line at the new shell's first prompt; only ever `true`.
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::OnlyTrue"))]
    pub retype: Option<bool>,
}

/// `POST /v1/shells/:id/rename`: a name for the shell, or `None` to take it away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct RenameShellRequest {
    #[cfg_attr(feature = "schema", schemars(with = "crate::schema::IdempotencyKey"))]
    pub idempotency_key: String,
    /// Required, null or not, as zod's `.nullable()` holds it: a rename that leaves it out asks
    /// for nothing.
    #[serde(deserialize_with = "Option::deserialize")]
    #[cfg_attr(
        feature = "schema",
        schemars(with = "crate::schema::Required<crate::schema::ShellName>")
    )]
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

/// The most UTF-8 bytes a command line kept to type back has.
pub const COMMAND_LINE_MAX_BYTES: usize = 2048;

/// Whether `line`, as a shell reported running it, is one kept to type back into the shell's
/// replacement without Enter, as `ShellCommandLine` in packages/protocol holds it. A control
/// character there is a key, not text: a newline or carriage return would run the line, and an
/// escape would drive the line editor. A line that starts with a space is one the user kept out
/// of their history, so it is kept out of this too. A Rust string holds no lone surrogate.
pub fn shell_command_line(line: &str) -> bool {
    !line.is_empty()
        && !line.starts_with(' ')
        && crate::text::showable(line)
        && !crate::text::has_invisible(line)
        && line.len() <= COMMAND_LINE_MAX_BYTES
}

/// The most UTF-16 units a reported line has, as zod's `.max(2048)` on `ShellReport`'s `command`
/// counts them: a bound on the report, not on the line kept, which is [`COMMAND_LINE_MAX_BYTES`].
pub const REPORTED_LINE_MAX_UNITS: usize = 2048;

/// The most UTF-16 units a shell's report token has.
pub const SHELL_TOKEN_MAX_UNITS: usize = 128;

/// What a shell's integration reports over the daemon's socket, as the shell starts running a
/// line: never over HTTP. `token` is the shell's own, from its environment.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ShellReport {
    #[cfg_attr(feature = "schema", schemars(length(min = 1, max = SHELL_TOKEN_MAX_UNITS)))]
    pub token: String,
    /// When the shell started running the line, in microseconds since the epoch: a report earlier
    /// than the kept one, arriving late, changes nothing.
    #[serde(deserialize_with = "crate::js_number::whole")]
    pub at: u64,
    /// The line, or `None` for one its client couldn't send whole: too long, or not UTF-8. The
    /// field is required, null or not, as zod's `.nullable()` holds it.
    #[serde(deserialize_with = "Option::deserialize")]
    #[cfg_attr(
        feature = "schema",
        schemars(with = "crate::schema::Required<crate::schema::ReportedLine>")
    )]
    pub command: Option<String>,
}

impl ShellReport {
    /// Whether the report holds to `ShellReport`'s bounds beyond its shape: a token of 1 to 128
    /// UTF-16 units, `at` a safe integer, and a line of at most 2048 UTF-16 units.
    pub fn bounded(&self) -> bool {
        token_bounded(&self.token)
            && self.at <= crate::edge::MAX_SAFE_INTEGER
            && self
                .command
                .as_ref()
                .is_none_or(|line| line.encode_utf16().count() <= REPORTED_LINE_MAX_UNITS)
    }
}

/// Neither the token nor the line it ran is shown: the token proves the shell, and the line may
/// hold a secret typed at its prompt.
impl std::fmt::Debug for ShellReport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShellReport")
            .field("at", &self.at)
            .finish_non_exhaustive()
    }
}

/// What a shell's integration reports over the daemon's socket once, at the shell's first prompt:
/// its line editor is reading, so a line can be typed back. `brackets` says the editor reads a
/// paste marked with the bracketed-paste sequences even before it has asked for bracketed paste,
/// so the daemon marks it itself. Only a shell's own integration says so: no request from a client
/// carries it.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ShellPrompt {
    #[cfg_attr(feature = "schema", schemars(length(min = 1, max = SHELL_TOKEN_MAX_UNITS)))]
    pub token: String,
    #[serde(
        default,
        deserialize_with = "crate::nullable::optional",
        skip_serializing_if = "Option::is_none"
    )]
    #[cfg_attr(feature = "schema", schemars(with = "bool"))]
    pub brackets: Option<bool>,
}

impl ShellPrompt {
    /// Whether the token is 1 to 128 UTF-16 units.
    pub fn bounded(&self) -> bool {
        token_bounded(&self.token)
    }
}

/// The token proves the shell, so it is never shown.
impl std::fmt::Debug for ShellPrompt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShellPrompt")
            .field("brackets", &self.brackets)
            .finish_non_exhaustive()
    }
}

/// What a shell's integration reports over the daemon's socket instead of [`ShellPrompt`], once,
/// at the first prompt of a shell that won't take a line typed back: a line held for it is dropped
/// at once. It has a route of its own, so a daemon that predates it answers 404 rather than read
/// it as a prompt.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct ShellDecline {
    #[cfg_attr(feature = "schema", schemars(length(min = 1, max = SHELL_TOKEN_MAX_UNITS)))]
    pub token: String,
}

impl ShellDecline {
    /// Whether the token is 1 to 128 UTF-16 units.
    pub fn bounded(&self) -> bool {
        token_bounded(&self.token)
    }
}

/// The token proves the shell, so it is never shown.
impl std::fmt::Debug for ShellDecline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShellDecline").finish_non_exhaustive()
    }
}

fn token_bounded(token: &str) -> bool {
    (1..=SHELL_TOKEN_MAX_UNITS).contains(&token.encode_utf16().count())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_a_line_that_can_be_typed_back_as_text() {
        let long = "a".repeat(COMMAND_LINE_MAX_BYTES);
        let kept = ["make", "echo \"$HOME\" 'a  b'", "echo café", &long];
        let refused = [
            "",
            " secret",
            "make\nrm -rf ~",
            "make\r",
            "make\u{1b}[D",
            "make\u{85}",
            "ls \u{202e}",
            "ls \u{200b}",
            "ls \u{feff}",
            &format!("{long}a"),
            &format!("{}é", "a".repeat(COMMAND_LINE_MAX_BYTES - 1)),
        ];
        assert_eq!(
            kept.map(shell_command_line),
            [true; 4],
            "a line that can be typed back is kept"
        );
        assert_eq!(
            refused.map(shell_command_line),
            [false; 11],
            "a line that can't is not"
        );
    }

    #[test]
    fn reads_a_report_as_the_hook_sends_it_and_holds_it_to_its_bounds() {
        let read = |text: &str| serde_json::from_str::<ShellReport>(text).ok();
        let report = read(r#"{"token":"t","at":7,"command":null,"extra":1}"#).unwrap();
        assert_eq!((report.at, report.command.as_deref()), (7, None));
        assert!(report.bounded());
        assert!(
            read(r#"{"token":"t","at":7}"#).is_none(),
            "command is required"
        );
        assert!(read(r#"{"token":"t","at":-1,"command":"ls"}"#).is_none());
        let bounds = [
            r#"{"token":"","at":0,"command":"ls"}"#.to_owned(),
            format!(r#"{{"token":"{}","at":0,"command":"ls"}}"#, "t".repeat(129)),
            r#"{"token":"t","at":9007199254740992,"command":"ls"}"#.to_owned(),
            format!(r#"{{"token":"t","at":0,"command":"{}"}}"#, "é".repeat(2049)),
        ];
        assert_eq!(
            bounds.map(|text| read(&text).unwrap().bounded()),
            [false; 4],
            "beyond its bounds"
        );
        let edge = format!(
            r#"{{"token":"{}","at":9007199254740991,"command":"{}"}}"#,
            "t".repeat(128),
            "é".repeat(2048)
        );
        assert!(read(&edge).unwrap().bounded(), "at its bounds");
    }

    #[test]
    fn holds_a_reported_line_to_2048_utf16_units_however_many_bytes_they_take() {
        let bounded = |line: String| {
            ShellReport {
                token: "t".to_owned(),
                at: 0,
                command: Some(line),
            }
            .bounded()
        };
        let taken = ["a".repeat(2048), "é".repeat(2048), "😀".repeat(1024)];
        let refused = [
            "a".repeat(2049),
            format!("{}a", "é".repeat(2048)),
            format!("{}a", "😀".repeat(1024)),
        ];
        assert_eq!(
            taken.map(bounded),
            [true; 3],
            "2048 units, in 2048 bytes or 4096"
        );
        assert_eq!(refused.map(bounded), [false; 3], "2049 units");
    }

    #[test]
    fn reads_a_prompt_with_or_without_brackets_but_never_null() {
        let read = |text: &str| serde_json::from_str::<ShellPrompt>(text).ok();
        assert_eq!(read(r#"{"token":"t"}"#).unwrap().brackets, None);
        assert_eq!(
            read(r#"{"token":"t","brackets":true}"#).unwrap().brackets,
            Some(true)
        );
        assert!(read(r#"{"token":"t","brackets":null}"#).is_none());
        assert!(!read(r#"{"token":""}"#).unwrap().bounded());
        assert!(
            !serde_json::from_str::<ShellDecline>(r#"{"token":""}"#)
                .unwrap()
                .bounded()
        );
        assert!(
            serde_json::from_str::<ShellDecline>(r#"{"token":"t"}"#)
                .unwrap()
                .bounded()
        );
    }

    #[test]
    fn shows_neither_token_nor_line_in_debug() {
        let report = ShellReport {
            token: "s3cret-token".to_owned(),
            at: 1,
            command: Some("export TOKEN=s3cret".to_owned()),
        };
        let prompt = ShellPrompt {
            token: "s3cret-token".to_owned(),
            brackets: None,
        };
        let decline = ShellDecline {
            token: "s3cret-token".to_owned(),
        };
        let shown = format!("{report:?} {prompt:?} {decline:?}");
        assert!(!shown.contains("s3cret"), "{shown}");
    }
}

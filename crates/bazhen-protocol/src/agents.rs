//! Agents, the snapshot of everything the daemon holds, and the fleet as `bazhen agents --json`
//! prints it.

use serde::{Deserialize, Serialize};

use crate::ids::{AgentId, AssignmentId, AttentionId, EnvironmentId, TaskId, TerminalId};
use crate::mail::{Attention, AttentionKind, Message, ObservedMessage};
use crate::names::{AgentName, Role};
use crate::notices::Notice;
use crate::shells::{BusyShell, NeedsRestart, Shell, TuiTheme};
use crate::tasks::{Assignment, Task};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentState {
    /// Until its harness shows a sign of life, even once its terminal runs: a TUI held at a trust
    /// or login dialog isn't up. A respawn or relaunch returns it here.
    Starting,
    /// Its harness has shown it is up since it last started: the state to wait on for an agent
    /// that is ready.
    Running,
    Exited,
    Unknown,
    Lost,
    Closing,
    Closed,
    Failed,
}

impl AgentState {
    /// Closed or failed: its name may be another's now.
    pub fn ended(self) -> bool {
        matches!(self, Self::Closed | Self::Failed)
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Starting => "starting",
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

/// The harnesses Bazhen runs agents in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessId {
    ClaudeCode,
    Codex,
}

impl HarnessId {
    pub const ALL: [Self; 2] = [Self::ClaudeCode, Self::Codex];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::ClaudeCode => "claude-code",
            Self::Codex => "codex",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|h| h.as_str() == text)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EnvironmentKind {
    Local,
    OpencodeServer,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Environment {
    pub id: EnvironmentId,
    pub kind: EnvironmentKind,
    /// The machine it runs on, as a human names it; empty from a daemon before it was said.
    #[serde(default)]
    pub host: String,
}

/// How a process ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ExitStatus {
    Exited { code: i64 },
    Signalled { signal: String },
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ExternalRefKind {
    ClaudeSession,
    CodexThread,
}

/// A harness- or server-side object, such as a Claude Code session or a Codex thread.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalRef {
    pub environment_id: EnvironmentId,
    pub kind: ExternalRefKind,
    pub id: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ActivityValue {
    Working,
    WaitingInput,
    NeedsApproval,
    Idle,
    Done,
    Failed,
    Unknown,
}

impl ActivityValue {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Working => "working",
            Self::WaitingInput => "waiting_input",
            Self::NeedsApproval => "needs_approval",
            Self::Idle => "idle",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Unknown => "unknown",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ActivitySource {
    Native,
    Heuristic,
}

/// What a harness last reported an agent doing.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    pub value: ActivityValue,
    pub source: ActivitySource,
    pub confidence: f64,
    pub observed_at: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The model an agent runs and how full its context is, each part once its harness says it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Usage {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_used_percent: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub context_window_tokens: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AgentCommand {
    Close,
    Respawn,
    Signal,
    Relaunch,
}

/// An agent's latest note on any task, the first line of it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Headline {
    pub text: String,
    pub task_id: TaskId,
    pub at: String,
}

fn dark() -> TuiTheme {
    TuiTheme::Dark
}

fn only_dark() -> Vec<TuiTheme> {
    vec![TuiTheme::Dark]
}

/// An agent. A field with a default is missing from a daemon older than it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    pub id: AgentId,
    /// Empty only from a daemon older than names.
    #[serde(default)]
    pub name: String,
    pub environment_id: EnvironmentId,
    pub harness: HarnessId,
    pub project: String,
    pub cwd: String,
    pub state: AgentState,
    pub terminal_id: Option<TerminalId>,
    pub generation: Option<u64>,
    pub external_ref: Option<ExternalRef>,
    pub exit: Option<ExitStatus>,
    #[serde(default = "dark")]
    pub theme: TuiTheme,
    #[serde(default = "only_dark")]
    pub themes: Vec<TuiTheme>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activity: Option<Activity>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub usage: Option<Usage>,
    #[serde(default)]
    pub attach_command: Option<String>,
    #[serde(default)]
    pub commands: Vec<AgentCommand>,
    #[serde(default)]
    pub resumable: bool,
    #[serde(default)]
    pub can_open_shell: bool,
    /// The agent that launched it to delegate to it; null when the human did.
    #[serde(default)]
    pub launched_by: Option<AgentId>,
    #[serde(default)]
    pub listening: bool,
    #[serde(default)]
    pub headline: Option<Headline>,
    #[serde(default)]
    pub needs_restart: Option<NeedsRestart>,
    /// The role whose prompt it was launched with.
    #[serde(default)]
    pub role: Option<Role>,
    /// Whether the prompt it would start with now differs from the one its last start gave it.
    #[serde(default)]
    pub prompt_changed: bool,
}

/// Everything the daemon holds, consistent as of `event_id` in store `epoch`. A list is missing
/// from a daemon older than it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StateSnapshot {
    pub epoch: String,
    pub event_id: u64,
    pub environments: Vec<Environment>,
    pub agents: Vec<Agent>,
    pub attention: Vec<Attention>,
    pub messages: Vec<Message>,
    #[serde(default)]
    pub shells: Vec<Shell>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub assignments: Vec<Assignment>,
    #[serde(default)]
    pub notices: Vec<Notice>,
    #[serde(default)]
    pub observed: Vec<ObservedMessage>,
}

/// What an agent last reported doing, and how long ago, by the clock of the CLI that printed it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetSignal {
    pub value: ActivityValue,
    pub source: ActivitySource,
    pub age_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetHeadline {
    pub text: String,
    pub task_id: TaskId,
    pub age_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetTask {
    pub task_id: TaskId,
    pub assignment_id: AssignmentId,
    pub role: Role,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct FleetAttention {
    pub id: AttentionId,
    pub kind: AttentionKind,
}

/// One agent as `bazhen agents --json` prints it for a program. The fields are in the order it
/// prints them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FleetAgent {
    pub id: AgentId,
    pub name: String,
    pub harness: HarnessId,
    pub state: AgentState,
    pub project: String,
    pub cwd: String,
    pub launched_by: Option<AgentId>,
    pub signal: Option<FleetSignal>,
    pub listening: bool,
    pub headline: Option<FleetHeadline>,
    pub tasks: Vec<FleetTask>,
    pub attention: Vec<FleetAttention>,
}

/// `POST /v1/agents/:id/rename`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameAgentRequest {
    pub idempotency_key: String,
    pub name: AgentName,
}

/// Who the daemon takes the request that asked to be: an agent, or the human as none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CallerResponse {
    /// Required, null for the human: optional, any JSON object would read as the human, such as
    /// a success from another build that holds no `agentId`.
    #[serde(deserialize_with = "Option::deserialize")]
    pub agent_id: Option<AgentId>,
}

/// What a command on an agent produced: the events it recorded, none if there was nothing to do.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommandResponse {
    pub agent_id: AgentId,
    pub event_ids: Vec<u64>,
}

/// A signal a running agent's process may be sent, in place of typing a key into it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum Signal {
    Sigint,
    Sigterm,
    Sighup,
    Sigkill,
}

impl Signal {
    pub const ALL: [Self; 4] = [Self::Sigint, Self::Sigterm, Self::Sighup, Self::Sigkill];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Sigint => "SIGINT",
            Self::Sigterm => "SIGTERM",
            Self::Sighup => "SIGHUP",
            Self::Sigkill => "SIGKILL",
        }
    }
}

/// `POST /v1/agents`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchAgentRequest {
    pub idempotency_key: String,
    pub harness: HarnessId,
    pub cwd: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<TuiTheme>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<AgentName>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
}

/// What a launch produced: the agent, its terminal once it has one, and the events recorded.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LaunchAgentResponse {
    pub agent_id: AgentId,
    #[serde(deserialize_with = "Option::deserialize")]
    pub terminal_id: Option<TerminalId>,
    pub event_ids: Vec<u64>,
}

/// `POST /v1/agents/:id/close`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CloseAgentRequest {
    pub idempotency_key: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub force: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub keep_shells: Option<Vec<TerminalId>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirm_busy: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub confirmed_busy: Option<Vec<BusyShell>>,
}

/// `POST /v1/agents/:id/respawn`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RespawnAgentRequest {
    pub idempotency_key: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<TuiTheme>,
}

/// `POST /v1/agents/:id/relaunch`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RelaunchAgentRequest {
    pub idempotency_key: String,
    pub generation: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<TuiTheme>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fresh: Option<bool>,
}

/// `POST /v1/agents/:id/signal`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SignalAgentRequest {
    pub idempotency_key: String,
    pub generation: u64,
    pub signal: Signal,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::from_slice;

    #[test]
    fn a_caller_is_an_agent_or_the_human_and_a_refusal_is_neither() {
        let agent = "agent_0190c3b2a1d47a3b8c1d2e3f4a5b6c7d";
        let read = |json: &str| from_slice::<CallerResponse>(json.as_bytes()).ok();
        assert_eq!(
            [
                read(&format!(r#"{{"agentId":"{agent}"}}"#)),
                read(r#"{"agentId":null}"#),
                read(r#"{"error":"forbidden","message":"Codex thread t is no live agent's"}"#),
            ],
            [
                Some(CallerResponse {
                    agent_id: AgentId::parse(agent)
                }),
                Some(CallerResponse { agent_id: None }),
                None,
            ]
        );
    }
}

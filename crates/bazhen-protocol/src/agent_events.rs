//! The payloads of the `agent.*` events, in the order the TypeScript daemon writes them: a key
//! zod's schema marks optional is left out when absent, and one it marks nullable is written null.

use serde::{Deserialize, Serialize};

use crate::agents::{ExitStatus, ExternalRef, HarnessId, Signal, Usage};
use crate::events::RuntimeRefPayload;
use crate::ids::{AgentId, EnvironmentId, TerminalId};
use crate::names::Role;
use crate::shells::TuiTheme;

/// The payload of `agent.launched`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentLaunched {
    pub environment_id: EnvironmentId,
    pub harness: HarnessId,
    pub project: String,
    pub cwd: String,
    pub terminal_id: Option<TerminalId>,
    /// The agent that launched it to delegate to it; absent when the human did.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launched_by: Option<AgentId>,
    /// Absent from an older daemon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    /// The `<n>` its default name took, which no later default takes again.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name_ordinal: Option<u64>,
    /// The runtime its terminal is created on; tmux, from an older daemon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
    /// The role whose prompt it was launched with; absent for none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub role: Option<Role>,
    /// The SHA-256 of the system prompt its launch gives it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_hash: Option<String>,
    /// The compaction window every start of it is given; absent, the harness's own.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub compact_window_tokens: Option<u32>,
}

/// The payload of `agent.renamed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRenamed {
    pub name: String,
    pub previous: String,
}

/// The payload of `agent.running`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRunning {
    pub external_ref: Option<ExternalRef>,
    /// Null with no local terminal.
    pub runtime_ref: Option<RuntimeRefPayload>,
    /// The theme the TUI was started for, when one was named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<TuiTheme>,
    /// The name the harness's session was started with, for one that is addressed by it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_name: Option<String>,
}

/// What showed the harness alive.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ReadySign {
    ClaudeHook,
    CodexTitle,
}

/// The payload of `agent.ready`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentReady {
    pub sign: ReadySign,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AgentFailedReason {
    LaunchRejected,
    /// The daemon died mid-launch, and its terminal never appeared.
    DaemonRestart,
}

/// The payload of `agent.failed`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentFailed {
    pub reason: AgentFailedReason,
    /// What went wrong, with secrets taken out, at most 500 grapheme clusters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The payload of `agent.process_adopted`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentProcessAdopted {
    pub runtime_ref: RuntimeRefPayload,
}

/// The payload of `agent.respawned` and `agent.relaunched`: the start's new incarnation.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRestarted {
    pub external_ref: Option<ExternalRef>,
    pub runtime_ref: RuntimeRefPayload,
    /// The theme the TUI was started for, when one was named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<TuiTheme>,
    /// The name the harness's session was started with, for one that is addressed by it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub harness_name: Option<String>,
    /// The SHA-256 of the system prompt the start gave it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub prompt_hash: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RespawnRejectedReason {
    NotResumable,
    NoTerminal,
    TerminalChanged,
    /// The harness's server answered that it won't resume the session.
    HarnessRefused,
    Unavailable,
    /// The daemon died mid-respawn, before the new process started.
    DaemonRestart,
}

/// The payload of `agent.respawn_rejected`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRespawnRejected {
    pub reason: RespawnRejectedReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The payload of `agent.relaunch_requested`: the new terminal it starts on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentRelaunchRequested {
    pub terminal_id: TerminalId,
    pub generation: u64,
    /// On a new harness session, which the old one's conversation doesn't carry into.
    pub fresh: bool,
    /// The runtime its terminal is created on; tmux, from an older daemon.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum RelaunchRejectedReason {
    NotResumable,
    TerminalExists,
    /// The harness's server answered that it won't start the session.
    HarnessRefused,
    Unavailable,
    /// The daemon died mid-relaunch, and the new terminal never appeared.
    DaemonRestart,
}

/// The payload of `agent.relaunch_rejected`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentRelaunchRejected {
    pub reason: RelaunchRejectedReason,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The payload of `agent.external_ref_updated`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentExternalRefUpdated {
    pub external_ref: ExternalRef,
}

/// The payload of `agent.transcript_recorded`; the stream leaves the path out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentTranscriptRecorded {
    pub session_id: String,
    pub path: String,
}

/// The payload of `agent.signalled`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentSignalled {
    pub signal: Signal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompactedSign {
    ClaudeHook,
    CodexItem,
}

/// The Claude Code hook that reported a compaction: its session and process.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompactedHook {
    pub session_id: Option<String>,
    pub pid: i64,
}

/// The payload of `agent.compacted`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct AgentCompacted {
    pub sign: CompactedSign,
    /// The model and context use last recorded before it; absent when none was.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub before: Option<Usage>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hook: Option<CompactedHook>,
}

/// The payload of `agent.exited`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct AgentExited {
    pub exit: ExitStatus,
}

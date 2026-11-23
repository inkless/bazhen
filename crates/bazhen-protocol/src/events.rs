//! The event stream, `/v1/events`: the frames the daemon sends on it. An event is read as far as
//! its envelope; its payload is kept as it came, so an event type this build doesn't know reads
//! like any other.

use serde::{Deserialize, Serialize};

use crate::agents::EnvironmentKind;
use crate::ids::{
    AgentId, AssignmentId, AttachmentId, DeviceId, EnvironmentId, TaskId, TerminalId,
};
use crate::notices::{NoticeCloseReason, NoticeCloser, NoticeDevice};
use crate::record::Record;
use crate::shells::TuiTheme;
use crate::stream::AttachmentMode;

/// Why the stream couldn't resume from a cursor: older than retention, or not from this store.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ResetReason {
    Stale,
    Foreign,
}

impl ResetReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Stale => "stale",
            Self::Foreign => "foreign",
        }
    }
}

/// An event type the daemon records: the entity its events are about, and the top-level payload
/// keys a client is sent, in the order they are sent. The rest of a payload never leaves the
/// daemon: a task's brief, a message's body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EventKind {
    pub name: &'static str,
    pub entity: &'static str,
    pub streamed: &'static [&'static str],
}

const fn registered(
    name: &'static str,
    entity: &'static str,
    streamed: &'static [&'static str],
) -> EventKind {
    EventKind {
        name,
        entity,
        streamed,
    }
}

/// Every event type either daemon records, as `EVENTS` in packages/protocol/src/events.ts registers
/// them, held to it by the store's fixture.
pub const EVENT_KINDS: &[EventKind] = &[
    registered("environment.registered", "environment", &["kind"]),
    registered(
        "environment.harness_version",
        "environment",
        &["harness", "version", "previous"],
    ),
    registered(
        "agent.launched",
        "agent",
        &[
            "environmentId",
            "harness",
            "project",
            "cwd",
            "terminalId",
            "launchedBy",
            "name",
            "nameOrdinal",
            "runtime",
            "role",
            "promptHash",
            "compactWindowTokens",
        ],
    ),
    registered("agent.renamed", "agent", &["name", "previous"]),
    registered(
        "agent.running",
        "agent",
        &["externalRef", "runtimeRef", "theme", "harnessName"],
    ),
    registered("agent.ready", "agent", &["sign"]),
    registered("agent.failed", "agent", &["reason", "detail"]),
    registered("agent.lost", "agent", &[]),
    registered("agent.process_adopted", "agent", &["runtimeRef"]),
    registered("agent.respawn_requested", "agent", &[]),
    registered(
        "agent.respawned",
        "agent",
        &[
            "externalRef",
            "runtimeRef",
            "theme",
            "harnessName",
            "promptHash",
        ],
    ),
    registered("agent.respawn_rejected", "agent", &["reason", "detail"]),
    registered(
        "agent.relaunch_requested",
        "agent",
        &["terminalId", "generation", "fresh", "runtime"],
    ),
    registered(
        "agent.relaunched",
        "agent",
        &[
            "externalRef",
            "runtimeRef",
            "theme",
            "harnessName",
            "promptHash",
        ],
    ),
    registered("agent.relaunch_rejected", "agent", &["reason", "detail"]),
    registered("agent.external_ref_updated", "agent", &["externalRef"]),
    registered("agent.transcript_recorded", "agent", &["sessionId"]),
    registered("agent.signalled", "agent", &["signal"]),
    registered(
        "agent.activity",
        "agent",
        &[
            "value",
            "source",
            "confidence",
            "observedAt",
            "detail",
            "resetsAt",
        ],
    ),
    registered(
        "agent.usage",
        "agent",
        &[
            "model",
            "contextUsedPercent",
            "contextWindowTokens",
            "limits",
        ],
    ),
    registered("agent.compacted", "agent", &["sign", "before", "hook"]),
    registered("agent.exited", "agent", &["exit"]),
    registered("agent.closing", "agent", &[]),
    registered("agent.closed", "agent", &[]),
    registered(
        "terminal.opened",
        "terminal",
        &[
            "environmentId",
            "cwd",
            "linkedAgentId",
            "theme",
            "restartOf",
            "runtime",
        ],
    ),
    registered("terminal.running", "terminal", &["runtimeRef"]),
    registered("terminal.failed", "terminal", &["reason"]),
    registered("terminal.process_adopted", "terminal", &["runtimeRef"]),
    registered("terminal.lost", "terminal", &[]),
    registered("terminal.closing", "terminal", &[]),
    registered("terminal.closed", "terminal", &["reason"]),
    registered("terminal.foreground_changed", "terminal", &["command"]),
    registered("terminal.needs_restart", "terminal", &["protocol"]),
    registered("terminal.restart_cleared", "terminal", &[]),
    registered("terminal.unlinked", "terminal", &[]),
    registered("terminal.renamed", "terminal", &["name"]),
    registered("attachment.started", "attachment", &["terminalId", "mode"]),
    registered("attachment.ended", "attachment", &["reason"]),
    registered("mailbox.queued", "message", &["agentId", "from"]),
    registered("mailbox.offered", "message", &["promptId"]),
    registered("mailbox.emitted", "message", &[]),
    registered("mailbox.seen", "message", &["promptId"]),
    registered("mailbox.delivered", "message", &[]),
    registered("mailbox.accepted", "message", &["offline"]),
    registered("mailbox.undeliverable", "message", &["reason"]),
    registered(
        "message.observed",
        "observed_message",
        &["from", "to", "summary", "accepted", "toolUseId"],
    ),
    registered("mailbox.requeued", "message", &["reason"]),
    registered(
        "attention.opened",
        "attention",
        &[
            "agentId",
            "summary",
            "kind",
            "taskId",
            "messageId",
            "toolUseId",
            "mainAgent",
        ],
    ),
    registered("attention.answered", "attention", &["decision"]),
    registered("attention.closed", "attention", &["reason"]),
    registered("device.paired", "device", &["name"]),
    registered("device.revoked", "device", &[]),
    registered("notice.opened", "notice", &["kind", "summary", "device"]),
    registered("notice.closed", "notice", &["reason", "by", "fromDevice"]),
    registered("lease.granted", "terminal", &["attachmentId", "epoch"]),
    registered(
        "task.created",
        "task",
        &["title", "ownerAgentId", "parentTaskId", "delegatedFrom"],
    ),
    registered("task.finished", "task", &["outcome"]),
    registered(
        "task.owner_changed",
        "task",
        &["ownerAgentId", "delegatedFrom"],
    ),
    registered("task.noted", "task", &["handoff", "role"]),
    registered(
        "assignment.granted",
        "assignment",
        &["taskId", "agentId", "role", "parentAssignmentId"],
    ),
    registered("assignment.ended", "assignment", &["reason"]),
];

/// The registered type named `name`.
pub fn event_kind(name: &str) -> Option<&'static EventKind> {
    EVENT_KINDS.iter().find(|kind| kind.name == name)
}

/// One event, as the stream sends it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub id: u64,
    pub ts: String,
    #[serde(rename = "type")]
    pub kind: String,
    pub entity_type: String,
    pub entity_id: String,
    pub actor: String,
    #[serde(deserialize_with = "Option::deserialize")]
    pub causation_id: Option<u64>,
    #[serde(deserialize_with = "Option::deserialize")]
    pub correlation_id: Option<String>,
    pub payload: serde_json::Value,
}

/// A text frame the daemon sends on `/v1/events`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum EventFrame {
    Event {
        event: Event,
    },
    /// The cursor can't be resumed: read `/v1/state` again, and resume from its cursor.
    Reset {
        reason: ResetReason,
    },
}

/// A text frame a client sends on `/v1/events`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientEventFrame {
    /// Whether the client's page is in sight.
    Visibility { visible: bool },
}

/// The largest frame a client sends on `/v1/events`, which carries only whether its page is seen.
pub const EVENT_FRAME_MAX_BYTES: usize = 1024;

/// The payload of `task.created`, in the order the TypeScript daemon writes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCreated {
    pub title: String,
    pub brief: String,
    pub owner_agent_id: Option<AgentId>,
    pub parent_task_id: Option<TaskId>,
    pub delegated_from: Option<AssignmentId>,
}

/// The payload of `device.paired`: never the token, its hash or the code it was paired with.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DevicePaired {
    pub name: String,
}

/// The payload of `device.revoked`, which is empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct DeviceRevoked {}

/// The payload of `notice.opened`, in the order the TypeScript daemon writes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct NoticeOpened {
    pub kind: String,
    pub summary: String,
    pub device: Option<NoticeDevice>,
}

/// The payload of `notice.closed`. `from_device` is advisory: the device whose shell the socket
/// call came from, as its environment claimed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoticeClosed {
    pub reason: NoticeCloseReason,
    pub by: NoticeCloser,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_device: Option<DeviceId>,
}

/// The payload of `environment.registered`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct EnvironmentRegistered {
    pub kind: EnvironmentKind,
}

/// A runtime incarnation as an event records it: the runtime, and where it keeps the terminal,
/// every value a string, in the order the runtime wrote them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct RuntimeRefPayload {
    pub runtime: String,
    pub locator: Record<String>,
}

/// The payload of `terminal.opened`, in the order the TypeScript daemon writes it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpened {
    pub environment_id: EnvironmentId,
    pub cwd: String,
    pub linked_agent_id: Option<AgentId>,
    /// The theme it is opened for, when one was named.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub theme: Option<TuiTheme>,
    /// The lost shell it was opened to restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub restart_of: Option<TerminalId>,
    /// The runtime its terminal is created on; tmux, from an older daemon that says none.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
}

/// The payload of `terminal.running` and of `terminal.process_adopted`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalIncarnation {
    pub runtime_ref: RuntimeRefPayload,
}

/// Why a terminal failed: its runtime refused it, or the daemon died while opening it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalFailedReason {
    OpenRejected,
    DaemonRestart,
}

/// The payload of `terminal.failed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalFailed {
    pub reason: TerminalFailedReason,
}

/// Why a terminal closed: the user closed it, its shell exited, the agent it was linked to
/// closed, or a new shell replaced the lost one.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TerminalClosedReason {
    User,
    Exited,
    AgentClosed,
    Restarted,
}

/// The payload of `terminal.closed`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalClosed {
    pub reason: TerminalClosedReason,
}

/// The payload of `terminal.foreground_changed`: what runs in the shell's foreground, by name, or
/// `None` at its prompt.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalForegroundChanged {
    pub command: Option<String>,
}

/// The payload of `terminal.needs_restart`: the versions the terminal's holder speaks.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalNeedsRestart {
    pub protocol: Vec<String>,
}

/// The payload of `terminal.renamed`: the name the user gave, or `None` once taken away.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalRenamed {
    pub name: Option<String>,
}

/// The payload of `terminal.lost`, `terminal.closing` and `terminal.restart_cleared`, which is
/// empty.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct TerminalNoted {}

/// The payload of `attachment.started`: a view of a terminal, watching or driving it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AttachmentStarted {
    pub terminal_id: TerminalId,
    pub mode: AttachmentMode,
}

/// Why an attachment ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttachmentEndReason {
    ClientClosed,
    TerminalClosed,
    AttachFailed,
    DaemonRestart,
    Disconnected,
    EvictedSlow,
    TimedOut,
    Replaced,
}

/// The payload of `attachment.ended`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct AttachmentEnded {
    pub reason: AttachmentEndReason,
}

/// The payload of `lease.granted`: the attachment that now drives the terminal, and the epoch its
/// input is typed under, higher than any granted on the terminal before.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LeaseGranted {
    pub attachment_id: AttachmentId,
    pub epoch: u64,
}

//! Waiting for an agent, a shell, a task or a reply to reach a condition: `POST /v1/waits`.

use serde::{Deserialize, Serialize};

use crate::agents::Agent;
use crate::ids::{AgentId, MessageId, TaskId, TerminalId};
use crate::shells::Shell;
use crate::tasks::Task;

/// What an agent is waited on to be: a lifecycle state; `ended`, closed or failed; `ready`, its
/// harness up, as `running` says; or `idle`, its harness reporting an ended turn that came after
/// every message sent to it reached it.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum AgentCondition {
    Starting,
    Running,
    Exited,
    Unknown,
    Lost,
    Closing,
    Closed,
    Failed,
    Ended,
    Ready,
    Idle,
}

impl AgentCondition {
    pub const ALL: [Self; 11] = [
        Self::Starting,
        Self::Running,
        Self::Exited,
        Self::Unknown,
        Self::Lost,
        Self::Closing,
        Self::Closed,
        Self::Failed,
        Self::Ended,
        Self::Ready,
        Self::Idle,
    ];

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
            Self::Ended => "ended",
            Self::Ready => "ready",
            Self::Idle => "idle",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == text)
    }
}

/// What a shell is waited on to be: a lifecycle state, or `ended`, closed or failed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum ShellCondition {
    Creating,
    Running,
    Exited,
    Unknown,
    Lost,
    Closing,
    Closed,
    Failed,
    Ended,
}

impl ShellCondition {
    pub const ALL: [Self; 9] = [
        Self::Creating,
        Self::Running,
        Self::Exited,
        Self::Unknown,
        Self::Lost,
        Self::Closing,
        Self::Closed,
        Self::Failed,
        Self::Ended,
    ];

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
            Self::Ended => "ended",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|c| c.as_str() == text)
    }
}

/// What a task is waited on to be: `done` once it is finished done, or once no one is still on it
/// and someone completed their part.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum TaskCondition {
    Done,
}

/// What a wait is on. A reply is the first message the recipient of `message_id` queued back to
/// its sender after it, which only that sender may wait on.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(tag = "on", rename_all = "lowercase")]
pub enum WaitCondition {
    Agent {
        #[serde(rename = "agentId")]
        agent_id: AgentId,
        until: AgentCondition,
    },
    Shell {
        #[serde(rename = "shellId")]
        shell_id: TerminalId,
        until: ShellCondition,
    },
    Task {
        #[serde(rename = "taskId")]
        task_id: TaskId,
        until: TaskCondition,
    },
    Reply {
        #[serde(rename = "messageId")]
        message_id: MessageId,
    },
}

/// `POST /v1/waits`: answered once the condition is met or can't be, or at `timeout_ms`, which is
/// at most `MESSAGE_WAIT_MAX_MS`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WaitRequest {
    pub condition: WaitCondition,
    pub timeout_ms: u64,
    /// The caller waited on this condition before, and the daemon answered: a target gone from
    /// the state since then is judged gone, rather than refused as unknown.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(with = "bool"))]
    pub resumed: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum WaitVerdict {
    Met,
    /// It ended otherwise, or the task was cancelled.
    Never,
    /// A reply's message will never reach its recipient.
    Bounced,
    /// The timeout ran out first.
    Pending,
}

/// Where the condition stands, `said` as one line for a person, with what it is on as the
/// caller's `/v1/state` shows it: the agent (for a reply, its message's recipient), the shell or
/// the task.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct WaitResponse {
    pub verdict: WaitVerdict,
    pub said: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(with = "Agent"))]
    pub agent: Option<Agent>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(with = "Shell"))]
    pub shell: Option<Shell>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(with = "Task"))]
    pub task: Option<Task>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(feature = "schema", schemars(with = "MessageId"))]
    pub reply_id: Option<MessageId>,
}

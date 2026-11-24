//! Tasks, who is assigned them, their notes, and the commands on them.

use serde::{Deserialize, Serialize};

use crate::agents::HarnessId;
use crate::ids::{AgentId, AssignmentId, AttentionId, MessageId, TaskId};
use crate::names::{AgentName, AgentRef, Role};
use crate::text::trim;

/// The longest title a task holds, in UTF-16 code units, as zod counts a string's length.
pub const TASK_TITLE_MAX: usize = 200;
/// The longest brief a task holds, counted as a title is.
pub const TASK_BRIEF_MAX: usize = 20_000;

/// Whether `title` is one a task is stored with: trimmed, and neither empty nor too long.
#[must_use]
pub fn is_task_title(title: &str) -> bool {
    trim(title) == title && (1..=TASK_TITLE_MAX).contains(&title.encode_utf16().count())
}

/// Whether `brief` is one a task is stored with: neither empty nor too long.
#[must_use]
pub fn is_task_brief(brief: &str) -> bool {
    (1..=TASK_BRIEF_MAX).contains(&brief.encode_utf16().count())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum TaskState {
    Open,
    Done,
    Cancelled,
}

impl TaskState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Done => "done",
            Self::Cancelled => "cancelled",
        }
    }
}

/// How a task is finished.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum TaskOutcome {
    Done,
    Cancelled,
}

impl TaskOutcome {
    pub const ALL: [Self; 2] = [Self::Done, Self::Cancelled];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Done => "done",
            Self::Cancelled => "cancelled",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "lowercase")]
pub enum AssignmentState {
    Active,
    Ended,
}

impl AssignmentState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Ended => "ended",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AssignmentEndReason {
    Unassigned,
    Completed,
    TaskFinished,
    AgentClosed,
    ParentEnded,
}

impl AssignmentEndReason {
    pub const ALL: [Self; 5] = [
        Self::Unassigned,
        Self::Completed,
        Self::TaskFinished,
        Self::AgentClosed,
        Self::ParentEnded,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unassigned => "unassigned",
            Self::Completed => "completed",
            Self::TaskFinished => "task_finished",
            Self::AgentClosed => "agent_closed",
            Self::ParentEnded => "parent_ended",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Task {
    pub id: TaskId,
    pub title: String,
    pub state: TaskState,
    pub owner_agent_id: Option<AgentId>,
    pub parent_task_id: Option<TaskId>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Assignment {
    pub id: AssignmentId,
    pub task_id: TaskId,
    pub agent_id: AgentId,
    pub role: Role,
    pub parent_assignment_id: Option<AssignmentId>,
    pub state: AssignmentState,
    pub end_reason: Option<AssignmentEndReason>,
}

/// A note on a task, from the agent working it or the human: progress, or a handoff.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TaskNote {
    pub event_id: u64,
    pub task_id: TaskId,
    pub agent_id: Option<AgentId>,
    pub role: Option<Role>,
    pub text: String,
    pub handoff: bool,
    pub at: String,
}

/// `GET /v1/tasks/:id`: a task with its brief, assignments, subtasks and notes.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TaskDetail {
    pub id: TaskId,
    pub title: String,
    pub state: TaskState,
    pub owner_agent_id: Option<AgentId>,
    pub parent_task_id: Option<TaskId>,
    pub brief: String,
    pub note: Option<String>,
    pub assignments: Vec<Assignment>,
    pub subtasks: Vec<Task>,
    #[serde(default)]
    pub notes: Vec<TaskNote>,
}

/// An agent given a role on a task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Grant {
    pub agent_id: AgentRef,
    pub role: Role,
}

/// `POST /v1/tasks`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskRequest {
    pub idempotency_key: String,
    pub title: String,
    pub brief: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assign: Option<Grant>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct CreateTaskResponse {
    pub task_id: TaskId,
    /// Null when the request assigned no one.
    pub assignment_id: Option<AssignmentId>,
    pub event_ids: Vec<u64>,
}

/// `POST /v1/tasks/:id/assign`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AssignTaskRequest {
    pub idempotency_key: String,
    pub agent_id: AgentRef,
    pub role: Role,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AssignTaskResponse {
    pub assignment_id: AssignmentId,
    pub event_ids: Vec<u64>,
}

/// `POST /v1/tasks/:id/unassign`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct UnassignTaskRequest {
    pub idempotency_key: String,
    pub assignment_id: String,
}

/// `POST /v1/tasks/:id/finish`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct FinishTaskRequest {
    pub idempotency_key: String,
    pub outcome: TaskOutcome,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cascade: Option<bool>,
}

/// `POST /v1/tasks/:id/notes`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AddTaskNoteRequest {
    pub idempotency_key: String,
    pub text: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub handoff: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TaskCommandResponse {
    pub event_ids: Vec<u64>,
}

/// A new agent to launch for a delegated task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct Launch {
    pub harness: HarnessId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cwd: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<AgentName>,
}

/// `POST /v1/tasks/delegate`: a subtask given to an agent named, or to one launched for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct DelegateTaskRequest {
    pub idempotency_key: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub from_task_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub agent_id: Option<AgentRef>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub launch: Option<Launch>,
    #[serde(default)]
    pub role: Role,
    pub title: String,
    pub brief: String,
}

/// `POST /v1/escalations`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EscalateRequest {
    pub idempotency_key: String,
    pub summary: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub task_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct EscalateResponse {
    pub attention_id: AttentionId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct SentTo {
    pub agent_id: AgentId,
    pub message_id: MessageId,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct Skipped {
    pub agent_id: AgentId,
    pub reason: String,
}

/// `POST /v1/tasks/:id/messages`: one message to each of the task's assignees but the sender.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct BroadcastMessageResponse {
    pub sent: Vec<SentTo>,
    /// Assignees that take no mail now.
    pub skipped: Vec<Skipped>,
    pub event_ids: Vec<u64>,
}

#[cfg(test)]
mod stored_text {
    use super::*;

    #[test]
    fn takes_a_title_trimmed_and_up_to_200_utf16_units_as_zod_counts_them() {
        let astral = "\u{1f600}".repeat(100);
        let verdicts = [
            is_task_title("Ship"),
            is_task_title(&astral),
            is_task_title(&format!("{astral}a")),
            is_task_title(" Ship"),
            is_task_title("Ship\u{feff}"),
            is_task_title("Ship\u{85}"),
            is_task_title(""),
        ];
        assert_eq!(verdicts, [true, true, false, false, false, true, false]);
    }

    #[test]
    fn takes_a_brief_up_to_20000_utf16_units_untrimmed() {
        let verdicts = [
            is_task_brief(" "),
            is_task_brief(&"b".repeat(TASK_BRIEF_MAX)),
            is_task_brief(&"b".repeat(TASK_BRIEF_MAX + 1)),
            is_task_brief(""),
        ];
        assert_eq!(verdicts, [true, true, false, false]);
    }
}

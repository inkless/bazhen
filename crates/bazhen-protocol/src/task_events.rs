//! The payloads of the `task.*` events after `task.created`, and of the `assignment.*` ones, in
//! the order the TypeScript daemon writes them: a key zod's schema marks nullable is written null.

use serde::{Deserialize, Serialize};

use crate::ids::{AgentId, AssignmentId, TaskId};
use crate::names::Role;
use crate::tasks::{AssignmentEndReason, TaskOutcome};

/// The payload of `task.finished`, which ends every active assignment on the task.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TaskFinished {
    pub outcome: TaskOutcome,
    pub note: Option<String>,
}

/// The payload of `task.owner_changed`: the task moved up to its parent's owner, since what made
/// its owner the owner ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct TaskOwnerChanged {
    pub owner_agent_id: Option<AgentId>,
    pub delegated_from: Option<AssignmentId>,
}

/// The payload of `task.noted`: a note on the task from its actor, the human or an agent.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct TaskNoted {
    pub text: String,
    pub handoff: bool,
    /// The role its agent held on the task then; null for the human, and for an owner on none.
    pub role: Option<Role>,
}

/// The payload of `assignment.granted`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase")]
pub struct AssignmentGranted {
    pub task_id: TaskId,
    pub agent_id: AgentId,
    pub role: Role,
    pub parent_assignment_id: Option<AssignmentId>,
}

/// Why an assignment was ended by its own event: taken away, or its worker's part done. A task
/// finishing or an agent closing ends assignments through its own event.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "snake_case")]
pub enum AssignmentEndedReason {
    Unassigned,
    Completed,
}

impl AssignmentEndedReason {
    /// The end reason it is, as the assignment machine and the row name it.
    pub fn reason(self) -> AssignmentEndReason {
        match self {
            Self::Unassigned => AssignmentEndReason::Unassigned,
            Self::Completed => AssignmentEndReason::Completed,
        }
    }
}

/// The payload of `assignment.ended`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
pub struct AssignmentEnded {
    pub reason: AssignmentEndedReason,
}

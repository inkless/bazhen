//! The task and assignment events after `task.created`, as the TypeScript store projects them: a
//! task finished, moved up to another owner or noted, and an assignment granted or ended. Ending
//! one ends every assignment granted under it, however deep.

use bazhen_core::task;
use bazhen_protocol::ids::{AgentId, Id};
use bazhen_protocol::names::Role;
use bazhen_protocol::task_events::{
    AssignmentEnded, AssignmentGranted, TaskFinished, TaskNoted, TaskOwnerChanged,
};
use bazhen_protocol::tasks::{AssignmentEndReason, AssignmentState, TaskState};
use rusqlite::types::Value;
use rusqlite::{OptionalExtension, Transaction};

use crate::agent_events::{end_assignments, end_descendants, update};
use crate::events::{AppendError, int};
use crate::projections::At;

/// A change to a task after its creation.
#[derive(Debug, Clone, PartialEq)]
pub enum TaskChange {
    Finished(TaskFinished),
    OwnerChanged(TaskOwnerChanged),
    Noted(TaskNoted),
}

/// A change to an assignment.
#[derive(Debug, Clone, PartialEq)]
pub enum AssignmentChange {
    Granted(AssignmentGranted),
    Ended(AssignmentEnded),
}

impl TaskChange {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Finished(_) => "task.finished",
            Self::OwnerChanged(_) => "task.owner_changed",
            Self::Noted(_) => "task.noted",
        }
    }

    pub(crate) fn payload(&self) -> serde_json::Result<String> {
        match self {
            Self::Finished(p) => serde_json::to_string(p),
            Self::OwnerChanged(p) => serde_json::to_string(p),
            Self::Noted(p) => serde_json::to_string(p),
        }
    }
}

impl AssignmentChange {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::Granted(_) => "assignment.granted",
            Self::Ended(_) => "assignment.ended",
        }
    }

    pub(crate) fn payload(&self) -> serde_json::Result<String> {
        match self {
            Self::Granted(p) => serde_json::to_string(p),
            Self::Ended(p) => serde_json::to_string(p),
        }
    }
}

fn text(value: impl Into<String>) -> Value {
    Value::Text(value.into())
}

fn optional(value: Option<&str>) -> Value {
    value.map_or(Value::Null, text)
}

/// A row's `state`, or `None` when there is no such row.
fn state_of(tx: &Transaction<'_>, table: &str, id: &str) -> rusqlite::Result<Option<String>> {
    tx.query_row(
        &format!("SELECT state FROM {table} WHERE id = ?"),
        [id],
        |row| row.get(0),
    )
    .optional()
}

pub(crate) fn project_task(
    tx: &Transaction<'_>,
    at: &At<'_>,
    id: &str,
    actor: &str,
    change: &TaskChange,
) -> Result<(), AppendError> {
    let refuse = |reason: String| AppendError::Refused {
        event: change.name(),
        reason,
    };
    let state = state_of(tx, "tasks", id)?.ok_or_else(|| refuse(format!("no task {id}")))?;
    match change {
        TaskChange::OwnerChanged(p) => update(
            tx,
            at,
            "tasks",
            id,
            &[
                (
                    "owner_agent_id",
                    optional(p.owner_agent_id.as_ref().map(Id::as_str)),
                ),
                (
                    "delegated_from",
                    optional(p.delegated_from.as_ref().map(Id::as_str)),
                ),
            ],
        ),
        TaskChange::Finished(p) => {
            let was: TaskState = serde_json::from_value(serde_json::Value::String(state))?;
            let to = task::next(was, p.outcome).map_err(|e| refuse(e.to_string()))?;
            update(
                tx,
                at,
                "tasks",
                id,
                &[
                    ("state", text(to.as_str())),
                    ("note", optional(p.note.as_deref())),
                ],
            )?;
            end_assignments(
                tx,
                at,
                "task_id",
                id,
                AssignmentEndReason::TaskFinished.as_str(),
            )?;
            end_descendants(tx, at)
        }
        TaskChange::Noted(p) => {
            let author = AgentId::parse(actor);
            tx.execute(
                "INSERT INTO task_notes (event_id, task_id, agent_session_id, author_role, text,
                   handoff)
                 VALUES (?, ?, ?, ?, ?, ?)",
                (
                    int(at.id)?,
                    id,
                    author.as_ref().map(Id::as_str),
                    p.role.as_ref().map(Role::as_str),
                    &p.text,
                    i64::from(p.handoff),
                ),
            )?;
            Ok(())
        }
    }
}

pub(crate) fn project_assignment(
    tx: &Transaction<'_>,
    at: &At<'_>,
    id: &str,
    change: &AssignmentChange,
) -> Result<(), AppendError> {
    match change {
        AssignmentChange::Granted(p) => {
            tx.execute(
                "INSERT INTO assignments (id, task_id, agent_session_id, role,
                   parent_assignment_id, state, created_event_id, updated_event_id)
                 VALUES (?, ?, ?, ?, ?, 'active', ?, ?)",
                (
                    id,
                    p.task_id.as_str(),
                    p.agent_id.as_str(),
                    p.role.as_str(),
                    p.parent_assignment_id.as_ref().map(Id::as_str),
                    int(at.id)?,
                    int(at.id)?,
                ),
            )?;
            Ok(())
        }
        AssignmentChange::Ended(p) => {
            let refuse = |reason: String| AppendError::Refused {
                event: change.name(),
                reason,
            };
            let state = state_of(tx, "assignments", id)?
                .ok_or_else(|| refuse(format!("no assignment {id}")))?;
            let was: AssignmentState = serde_json::from_value(serde_json::Value::String(state))?;
            let reason = p.reason.reason();
            let to = task::next_assignment(was, reason).map_err(|e| refuse(e.to_string()))?;
            update(
                tx,
                at,
                "assignments",
                id,
                &[
                    ("state", text(to.as_str())),
                    ("end_reason", text(reason.as_str())),
                ],
            )?;
            end_descendants(tx, at)
        }
    }
}

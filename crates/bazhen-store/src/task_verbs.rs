//! The task verbs' writes, as `tasks/tasks.ts` makes them: each once per idempotency key, by a
//! caller that can act, on a task whose checks let it.

use bazhen_core::task::{TaskRefused, check_note};
use bazhen_protocol::ids::{AgentId, AssignmentId, TaskId};
use bazhen_protocol::names::Role;
use bazhen_protocol::task_events::{
    AssignmentEnded, AssignmentEndedReason, AssignmentGranted, TaskFinished, TaskNoted,
    TaskOwnerChanged,
};
use bazhen_protocol::tasks::{TaskCommandResponse, TaskOutcome};
use serde::Serialize;

use crate::tasks::open;
use crate::{
    AppendError, AssignmentChange, NewEvent, OnceError, Store, TaskChange, TaskReadError, Writer,
};

/// A note the caller asks to add to a task, its text already held to the protocol's rules and
/// trimmed: the human's, or an agent's.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewNote {
    pub caller: Option<AgentId>,
    pub task: TaskId,
    pub key: String,
    pub text: String,
    pub handoff: bool,
}

/// The note as the TypeScript daemon keeps it under its key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeptNote<'a> {
    caller: Option<&'a str>,
    task_id: &'a str,
    text: &'a str,
    handoff: bool,
}

/// Why a task verb did nothing.
#[derive(Debug, thiserror::Error)]
pub enum TaskVerbError {
    #[error("no task {0}")]
    NoTask(TaskId),
    /// The calling agent is gone, or was never there.
    #[error("no agent {0} that is open")]
    NoCaller(AgentId),
    /// The task's checks refuse the caller this.
    #[error(transparent)]
    Refused(#[from] TaskRefused),
    #[error(transparent)]
    Once(#[from] OnceError),
    #[error(transparent)]
    Append(#[from] AppendError),
    #[error(transparent)]
    Read(#[from] TaskReadError),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// Who an event is from: the agent that called, or the human.
fn actor(caller: Option<&AgentId>) -> String {
    caller.map_or("human", AgentId::as_str).to_owned()
}

impl Store {
    /// Notes the task for its caller, or answers what its key was first answered. The note
    /// carries the role its agent holds on the task, if any.
    ///
    /// # Errors
    ///
    /// [`TaskVerbError`]; nothing is recorded then.
    pub fn note_task(&mut self, note: &NewNote) -> Result<TaskCommandResponse, TaskVerbError> {
        let kept = serde_json::to_string(&KeptNote {
            caller: note.caller.as_ref().map(AgentId::as_str),
            task_id: note.task.as_str(),
            text: &note.text,
            handoff: note.handoff,
        })?;
        self.once(&note.key, &kept, |w| {
            let caller = note.caller.as_ref();
            if let Some(agent) = caller
                && !open(w, agent)?
            {
                return Err(TaskVerbError::NoCaller(agent.clone()));
            }
            let view = w
                .reads()
                .task_view(&note.task)?
                .ok_or_else(|| TaskVerbError::NoTask(note.task.clone()))?;
            check_note(&view, caller)?;
            let role = caller
                .and_then(|agent| view.active.iter().find(|a| a.agent_id == *agent))
                .map(|a| a.role.clone());
            let noted = w.append(&NewEvent::Task {
                task: note.task.clone(),
                actor: actor(caller),
                change: TaskChange::Noted(TaskNoted {
                    text: note.text.clone(),
                    handoff: note.handoff,
                    role,
                }),
            })?;
            Ok(TaskCommandResponse {
                event_ids: vec![noted],
            })
        })
    }
}

/// A role on a task that a verb gives an agent, its checks already passed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewGrant<'a> {
    pub caller: Option<&'a AgentId>,
    pub task: &'a TaskId,
    pub agent: &'a AgentId,
    pub role: &'a Role,
    /// The assignment it is granted under: none when the human or the task's owner grants it.
    pub parent: Option<AssignmentId>,
}

impl Writer<'_> {
    /// Records the grant, answering the new assignment's id and its event's.
    ///
    /// # Errors
    ///
    /// [`AppendError`]; nothing is recorded then.
    pub fn grant(&self, grant: &NewGrant<'_>) -> Result<(AssignmentId, u64), AppendError> {
        let id = AssignmentId::mint(
            crate::now_ms(),
            crate::urandom().map_err(AppendError::NoId)?,
        );
        let granted = self.append(&NewEvent::Assignment {
            assignment: id.clone(),
            actor: actor(grant.caller),
            change: AssignmentChange::Granted(AssignmentGranted {
                task_id: grant.task.clone(),
                agent_id: grant.agent.clone(),
                role: grant.role.clone(),
                parent_assignment_id: grant.parent.clone(),
            }),
        })?;
        Ok((id, granted))
    }

    /// Ends `assignment` for `reason`, by `caller`, and with it every one granted under it.
    ///
    /// # Errors
    ///
    /// [`AppendError`]: an assignment not active is refused.
    pub fn end_assignment(
        &self,
        caller: Option<&AgentId>,
        assignment: &AssignmentId,
        reason: AssignmentEndedReason,
    ) -> Result<u64, AppendError> {
        self.append(&NewEvent::Assignment {
            assignment: assignment.clone(),
            actor: actor(caller),
            change: AssignmentChange::Ended(AssignmentEnded { reason }),
        })
    }

    /// Finishes `task` as `outcome`, with `note`, by `caller`: every assignment on it ends, and
    /// with each every one granted under it.
    ///
    /// # Errors
    ///
    /// [`AppendError`]: a task already finished is refused.
    pub fn finish_task(
        &self,
        caller: Option<&AgentId>,
        task: &TaskId,
        outcome: TaskOutcome,
        note: Option<&str>,
    ) -> Result<u64, AppendError> {
        self.append(&NewEvent::Task {
            task: task.clone(),
            actor: actor(caller),
            change: TaskChange::Finished(TaskFinished {
                outcome,
                note: note.map(str::to_owned),
            }),
        })
    }

    /// Moves `task` to `owner`, the human as `None`, delegated from `delegated_from`: the system's
    /// doing, as a subtask moves up when its owner no longer holds it.
    ///
    /// # Errors
    ///
    /// [`AppendError`].
    pub fn change_owner(
        &self,
        task: &TaskId,
        owner: Option<AgentId>,
        delegated_from: Option<AssignmentId>,
    ) -> Result<u64, AppendError> {
        self.append(&NewEvent::Task {
            task: task.clone(),
            actor: "system".to_owned(),
            change: TaskChange::OwnerChanged(TaskOwnerChanged {
                owner_agent_id: owner,
                delegated_from,
            }),
        })
    }
}

#[cfg(test)]
mod tests;

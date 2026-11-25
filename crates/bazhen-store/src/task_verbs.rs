//! The task verbs' writes, as `tasks/tasks.ts` makes them: each once per idempotency key, by a
//! caller that can act, on a task whose checks let it.

use bazhen_core::task::{TaskRefused, check_note};
use bazhen_protocol::ids::{AgentId, TaskId};
use bazhen_protocol::task_events::TaskNoted;
use bazhen_protocol::tasks::TaskCommandResponse;
use serde::Serialize;

use crate::tasks::open;
use crate::{AppendError, NewEvent, OnceError, Store, TaskChange, TaskReadError};

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

#[cfg(test)]
mod tests;

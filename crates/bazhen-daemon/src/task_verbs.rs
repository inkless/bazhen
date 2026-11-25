//! The task verbs' routes (`http/app.ts`'s `taskRoute`s): each body held to the protocol at the
//! edge, then the verb run once per key in the store, which checks the caller may.

use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bazhen_core::roles::RoleBook;
use bazhen_core::task::{Refusal, TaskRefused, TasksHeld, check_grant};
use bazhen_harness::Harnesses;
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::edge::edge;
use bazhen_protocol::ids::{AgentId, TaskId};
use bazhen_protocol::names::Role;
use bazhen_protocol::roles::RoleDefinition;
use bazhen_protocol::tasks::{AddTaskNoteRequest, AssignTaskRequest, AssignTaskResponse};
use bazhen_store::{
    AppendError, NewGrant, NewNote, OnceError, Reads, TaskReadError, TaskVerbError,
    Writer as StoreWriter,
};
use serde::Serialize;

use crate::callers::{Caller, caller_of};
use crate::mail::{CLOSED_CALLER, GONE, MAIL_LIMIT, Queued, Sending, refusal, send_under};
use crate::routes::{Shared, fail, internal};
use crate::task_mail::{Agent, Handoff, assigned_mail, length, role_mail};

/// What a verb answers when the store did nothing: the status the TypeScript daemon gives each.
fn refused(err: &TaskVerbError) -> Response {
    let (status, code) = match err {
        TaskVerbError::NoTask(_) | TaskVerbError::NoCaller(_) => {
            (StatusCode::NOT_FOUND, ErrorCode::NotFound)
        }
        TaskVerbError::Refused(refused) => match refused.refusal {
            Refusal::Forbidden => (StatusCode::FORBIDDEN, ErrorCode::Forbidden),
            Refusal::Conflict => (StatusCode::CONFLICT, ErrorCode::Conflict),
        },
        TaskVerbError::Once(OnceError::Conflict(key)) => {
            return fail(
                StatusCode::CONFLICT,
                ErrorCode::Conflict,
                &format!("idempotency key {key} was first used for a different request"),
            );
        }
        TaskVerbError::Once(_)
        | TaskVerbError::Append(_)
        | TaskVerbError::Read(_)
        | TaskVerbError::Json(_)
        | TaskVerbError::Sqlite(_) => return internal(err),
    };
    fail(status, code, &err.to_string())
}

fn no_task(id: &str) -> Response {
    fail(
        StatusCode::NOT_FOUND,
        ErrorCode::NotFound,
        &format!("no task {id}"),
    )
}

/// `POST /v1/tasks/:id/notes`: a note on the task from the human, its owner or an agent on it.
pub(crate) async fn note(
    State(shared): State<Shared>,
    caller: Option<Extension<Caller>>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let req = match edge::<AddTaskNoteRequest>(&body) {
        Ok(req) => req,
        Err(refused) => {
            return fail(
                StatusCode::BAD_REQUEST,
                ErrorCode::InvalidRequest,
                &refused.0,
            );
        }
    };
    let Some(task) = TaskId::parse(&id) else {
        return no_task(&id);
    };
    let note = NewNote {
        caller: caller_of(caller),
        task,
        key: req.idempotency_key,
        text: req.text,
        handoff: req.handoff == Some(true),
    };
    match shared.store.run(move |store| store.note_task(&note)).await {
        Ok(Ok(noted)) => axum::Json(noted).into_response(),
        Ok(Err(err)) => refused(&err),
        Err(err) => internal(&err),
    }
}

/// Why a verb that gives an agent work did nothing.
#[derive(Debug)]
pub(crate) enum Granting {
    NoTask(String),
    /// The calling agent is gone, or was never there.
    NoCaller(AgentId),
    NoRole(Role),
    /// The agent to be given the work is gone, or was never there.
    NoAgent(String),
    Refused(TaskRefused),
    /// Its mail wasn't sent, nor anything else recorded, as a send's refusal says.
    Send(Sending),
}

impl From<Sending> for Granting {
    fn from(err: Sending) -> Self {
        Self::Send(err)
    }
}

impl From<TaskRefused> for Granting {
    fn from(err: TaskRefused) -> Self {
        Self::Refused(err)
    }
}

impl From<OnceError> for Granting {
    fn from(err: OnceError) -> Self {
        Self::Send(Sending::Once(err))
    }
}

impl From<rusqlite::Error> for Granting {
    fn from(err: rusqlite::Error) -> Self {
        Self::Send(Sending::from(err))
    }
}

impl From<AppendError> for Granting {
    fn from(err: AppendError) -> Self {
        Self::Send(Sending::from(err))
    }
}

impl From<TaskReadError> for Granting {
    fn from(err: TaskReadError) -> Self {
        Self::Send(Sending::Internal(err.to_string()))
    }
}

impl From<serde_json::Error> for Granting {
    fn from(err: serde_json::Error) -> Self {
        Self::Send(Sending::Internal(err.to_string()))
    }
}

/// The protocol's error for a verb that gave no one work, with `Tasks`'s words.
fn granting(err: Granting) -> Response {
    match err {
        Granting::NoTask(id) => no_task(&id),
        Granting::NoCaller(agent) => fail(
            StatusCode::NOT_FOUND,
            ErrorCode::NotFound,
            &format!("no agent {agent} that is open"),
        ),
        Granting::NoRole(role) => fail(
            StatusCode::BAD_REQUEST,
            ErrorCode::InvalidRequest,
            &format!("no role is defined as {role}: bazhen roles lists them"),
        ),
        Granting::NoAgent(agent) => fail(
            StatusCode::NOT_FOUND,
            ErrorCode::NotFound,
            &format!("no agent {agent} that can take a task"),
        ),
        Granting::Refused(refused) => {
            let (status, code) = match refused.refusal {
                Refusal::Forbidden => (StatusCode::FORBIDDEN, ErrorCode::Forbidden),
                Refusal::Conflict => (StatusCode::CONFLICT, ErrorCode::Conflict),
            };
            fail(status, code, &refused.to_string())
        }
        Granting::Send(err) => refusal(err),
    }
}

/// The assignment as the TypeScript daemon keeps it under its key, its agent as resolved.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeptAssign<'a> {
    caller: Option<&'a str>,
    task_id: &'a str,
    agent_id: &'a str,
    role: &'a str,
}

/// `POST /v1/tasks/:id/assign`: a role on the task for an agent, which is mailed its brief. The
/// agent is named by its id or its live name, resolved before the key is replayed.
pub(crate) async fn assign(
    State(shared): State<Shared>,
    caller: Option<Extension<Caller>>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let assigned = async {
        let req =
            edge::<AssignTaskRequest>(&body).map_err(|refused| Sending::Invalid(refused.0))?;
        let agents = shared.agents.clone().ok_or(Sending::Unavailable)?;
        let task = TaskId::parse(&id).ok_or_else(|| Granting::NoTask(id.clone()))?;
        let caller = caller_of(caller);
        let roles = shared.roles.current();
        let run = Arc::clone(&agents);
        let (response, queued) = shared
            .store
            .run(move |store| {
                let reference = req.agent_id.as_str();
                let agent = store
                    .reads()
                    .resolve_agent(reference)?
                    .ok_or_else(|| Sending::Unnamed(reference.to_owned()))?;
                let kept = serde_json::to_string(&KeptAssign {
                    caller: caller.as_ref().map(AgentId::as_str),
                    task_id: task.as_str(),
                    agent_id: &agent,
                    role: req.role.as_str(),
                })?;
                let mut queued = Vec::new();
                let response = store.once(&req.idempotency_key, &kept, |w| {
                    check_caller(w.reads(), caller.as_ref())?;
                    if roles.book.get(&req.role).is_none() {
                        return Err(Granting::NoRole(req.role.clone()));
                    }
                    let grant = Grant {
                        caller: caller.as_ref(),
                        task: &task,
                        agent: &agent,
                        role: &req.role,
                        book: &roles.book,
                        key: &req.idempotency_key,
                    };
                    grant.record(w, run.harnesses(), &mut queued)
                })?;
                Ok::<_, Granting>((response, queued))
            })
            .await
            .map_err(|err| Sending::Internal(err.to_string()))??;
        agents.hand(queued);
        Ok::<_, Granting>(response)
    };
    match assigned.await {
        Ok(response) => axum::Json(response).into_response(),
        Err(err) => granting(err),
    }
}

/// Refuses an agent caller that is gone, or was never there (`checkCaller`).
fn check_caller(reads: Reads<'_>, caller: Option<&AgentId>) -> Result<(), Granting> {
    let Some(caller) = caller else {
        return Ok(());
    };
    match reads.agent_state(caller.as_str())? {
        Some(state) if !CLOSED_CALLER.contains(&state.as_str()) => Ok(()),
        _ => Err(Granting::NoCaller(caller.clone())),
    }
}

/// A role on a task for an agent, as a verb asks for it, its role defined.
struct Grant<'a> {
    caller: Option<&'a AgentId>,
    task: &'a TaskId,
    /// As resolved, which may still name no agent that can take a task.
    agent: &'a str,
    role: &'a Role,
    book: &'a RoleBook,
    /// The verb's key, which the mail's keys are derived from.
    key: &'a str,
}

impl Grant<'_> {
    /// Grants the role, then mails the brief, last, so a refused send leaves nothing recorded
    /// (`grant`). An agent new to the role is sent its prompt first.
    fn record(
        &self,
        w: &StoreWriter<'_>,
        harnesses: &Harnesses,
        queued: &mut Vec<Queued>,
    ) -> Result<AssignTaskResponse, Granting> {
        let reads = w.reads();
        let agent = match AgentId::parse(self.agent) {
            Some(agent) if reachable(reads, &agent)? => agent,
            _ => return Err(Granting::NoAgent(self.agent.to_owned())),
        };
        let no_task = || Granting::NoTask(self.task.as_str().to_owned());
        let view = reads.task_view(self.task)?.ok_or_else(no_task)?;
        let detail = w.task_detail(self.task)?.ok_or_else(no_task)?;
        let grants = self.book.rules(self.role).grants;
        let caller_name = name_of(reads, self.caller)?;
        let from = self.caller.map(|id| Agent {
            id,
            name: &caller_name,
        });
        let note = reads.pending_handoff(self.task)?;
        let writer_name = name_of(reads, note.as_ref().and_then(|n| n.agent_id.as_ref()))?;
        let handoff = note.as_ref().map(|note| Handoff {
            text: &note.text,
            at: &note.at,
            by: note.agent_id.as_ref().map(|id| Agent {
                id,
                name: &writer_name,
            }),
            role: note.role.as_ref(),
        });
        let body = assigned_mail(&detail, self.role, grants, from, handoff);
        let long = length(&body);
        if long > MAIL_LIMIT {
            return Err(Sending::TooLong(long).into());
        }
        // Read before the grant is recorded, which would count as having held the role.
        let new_role = new_role(reads, &agent, self.role, self.book)?;
        let held = reads
            .active_assignments_of(&agent)?
            .iter()
            .filter(|a| a.role == *self.role)
            .count();
        let held = TasksHeld(u64::try_from(held).unwrap_or(u64::MAX));
        let parent = check_grant(&view, self.caller, &agent, self.role, self.book, held)?;
        let (assignment_id, granted) = w.grant(&NewGrant {
            caller: self.caller,
            task: self.task,
            agent: &agent,
            role: self.role,
            parent,
        })?;
        let mut event_ids = vec![granted];
        if let Some(definition) = new_role {
            let key = format!("{}:role", self.key);
            let told = send_under(
                w,
                harnesses,
                &agent,
                &key,
                &role_mail(&detail, definition),
                queued,
            )?;
            event_ids.extend(told.event_ids);
        }
        let key = format!("{}:assigned", self.key);
        let sent = send_under(w, harnesses, &agent, &key, &body, queued)?;
        event_ids.extend(sent.event_ids);
        Ok(AssignTaskResponse {
            assignment_id,
            event_ids,
        })
    }
}

/// Whether the agent can be given a task: one the store knows that isn't gone (`reachable`).
fn reachable(reads: Reads<'_>, agent: &AgentId) -> rusqlite::Result<bool> {
    Ok(reads
        .agent_state(agent.as_str())?
        .is_some_and(|state| !GONE.contains(&state.as_str())))
}

/// An agent's name as mail gives it, empty for none; empty for the human too, whom mail names
/// by no name.
fn name_of(reads: Reads<'_>, agent: Option<&AgentId>) -> rusqlite::Result<String> {
    let Some(agent) = agent else {
        return Ok(String::new());
    };
    Ok(reads
        .agent_name_and_state(agent.as_str())?
        .and_then(|(name, _)| name)
        .unwrap_or_default())
}

/// The role's definition, when the agent wasn't launched in it and holds it for the first time:
/// it is then sent the role's prompt, once (`newRole`).
fn new_role<'b>(
    reads: Reads<'_>,
    agent: &AgentId,
    role: &Role,
    book: &'b RoleBook,
) -> rusqlite::Result<Option<&'b RoleDefinition>> {
    let launched = reads.agent_launch(agent.as_str())?;
    if launched.is_some_and(|launch| launch.role.as_ref() == Some(role)) {
        return Ok(None);
    }
    if reads.has_held(agent, role)? {
        return Ok(None);
    }
    Ok(book.get(role))
}

#[cfg(test)]
mod tests;

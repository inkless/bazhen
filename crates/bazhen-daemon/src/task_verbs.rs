//! The task verbs' routes (`http/app.ts`'s `taskRoute`s): each body held to the protocol at the
//! edge, then the verb run once per key in the store, which checks the caller may.

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bazhen_core::roles::RoleBook;
use bazhen_core::task::{
    Refusal, TaskRefused, TasksHeld, check_delegate, check_grant, check_unassign,
};
use bazhen_harness::Harnesses;
use bazhen_protocol::daemon::ErrorCode;
use bazhen_protocol::edge::edge;
use bazhen_protocol::ids::{AgentId, AssignmentId, TaskId};
use bazhen_protocol::names::Role;
use bazhen_protocol::roles::RoleDefinition;
use bazhen_protocol::task_events::AssignmentEndedReason;
use bazhen_protocol::tasks::{
    AddTaskNoteRequest, AssignTaskRequest, AssignTaskResponse, CreateTaskResponse,
    Grant as TaskGrant, TaskCommandResponse, UnassignTaskRequest,
};
use bazhen_store::{
    AppendError, Assigning, CreateTaskError, NewGrant, NewNote, NewTask, OnceError, Reads,
    TaskReadError, TaskVerbError, Writer as StoreWriter,
};
use serde::Serialize;

use crate::callers::{Caller, caller_of};
use crate::mail::{CLOSED_CALLER, GONE, MAIL_LIMIT, Queued, Sending, queue, refusal, send_under};
use crate::routes::{Shared, fail, internal};
use crate::task_lift::lift_stranded;
use crate::task_mail::{
    Agent, Handoff, assigned_mail, length, line_ended_mail, role_mail, unassigned_mail,
};

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
    /// The task wasn't made.
    Create(CreateTaskError),
    /// Its mail wasn't sent, nor anything else recorded, as a send's refusal says.
    Send(Sending),
}

impl From<CreateTaskError> for Granting {
    fn from(err: CreateTaskError) -> Self {
        match err {
            CreateTaskError::Refused(refused) => Self::Refused(refused),
            err => Self::Create(err),
        }
    }
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
        Granting::Create(err @ (CreateTaskError::NoParent(_) | CreateTaskError::NoCaller(_))) => {
            fail(StatusCode::NOT_FOUND, ErrorCode::NotFound, &err.to_string())
        }
        Granting::Create(err @ CreateTaskError::ParentClosed(_)) => {
            fail(StatusCode::CONFLICT, ErrorCode::Conflict, &err.to_string())
        }
        Granting::Create(CreateTaskError::Once(err)) => refusal(&Sending::Once(err)),
        Granting::Create(err) => refusal(&Sending::Internal(err.to_string())),
        Granting::Send(err) => refusal(&err),
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
        let run = shared.agents.clone().ok_or(Sending::Unavailable)?;
        let task = TaskId::parse(&id).ok_or_else(|| Granting::NoTask(id.clone()))?;
        let caller = caller_of(caller);
        let roles = shared.roles.current();
        let response = shared
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
                        under: Under::Checked,
                    };
                    grant.record(w, run.harnesses(), &mut queued)
                })?;
                // Committed: handed over here, so a caller gone before the answer leaves none
                // of its mail behind.
                run.hand(queued);
                Ok::<_, Granting>(response)
            })
            .await
            .map_err(|err| Sending::Internal(err.to_string()))??;
        Ok::<_, Granting>(response)
    };
    match assigned.await {
        Ok(response) => axum::Json(response).into_response(),
        Err(err) => granting(err),
    }
}

/// Makes a task for its caller, and grants the role `assign` asks for on it in the same write, as
/// `create` does (`tasks.ts`). The agent is resolved by name or id before the key is replayed, as
/// the TypeScript daemon's route resolves it. An agent's subtask is granted under the assignment
/// it was delegated from.
pub(crate) async fn create(shared: Shared, task: NewTask, assign: Option<TaskGrant>) -> Response {
    let made = async {
        let run = match assign {
            Some(_) => Some(shared.agents.clone().ok_or(Sending::Unavailable)?),
            None => None,
        };
        let roles = shared.roles.current();
        let response = shared
            .store
            .run(move |store| {
                let agent = match &assign {
                    Some(grant) => {
                        let reference = grant.agent_id.as_str();
                        let agent = store.reads().resolve_agent(reference)?;
                        Some(agent.ok_or_else(|| Sending::Unnamed(reference.to_owned()))?)
                    }
                    None => None,
                };
                let assigning =
                    assign
                        .as_ref()
                        .zip(agent.as_deref())
                        .map(|(grant, agent)| Assigning {
                            agent_id: agent,
                            role: grant.role.as_str(),
                        });
                let kept = task.request_text_assigning(assigning.as_ref())?;
                let mut queued = Vec::new();
                let response = store.once(&task.key, &kept, |w| {
                    let made = w.create_task(&task, &roles.book)?;
                    let (Some(grant), Some(agent), Some(run)) = (&assign, &agent, &run) else {
                        return Ok(CreateTaskResponse {
                            task_id: made.task_id,
                            assignment_id: None,
                            event_ids: vec![made.event],
                        });
                    };
                    if roles.book.get(&grant.role).is_none() {
                        return Err(Granting::NoRole(grant.role.clone()));
                    }
                    let granted = Grant {
                        caller: task.caller.as_ref(),
                        task: &made.task_id,
                        agent,
                        role: &grant.role,
                        book: &roles.book,
                        key: &task.key,
                        under: match (&task.parent, &task.caller) {
                            (Some(parent), Some(by)) => Under::Delegated { parent, by },
                            _ => Under::Checked,
                        },
                    }
                    .record(w, run.harnesses(), &mut queued)?;
                    let mut event_ids = vec![made.event];
                    event_ids.extend(granted.event_ids);
                    Ok(CreateTaskResponse {
                        task_id: made.task_id,
                        assignment_id: Some(granted.assignment_id),
                        event_ids,
                    })
                })?;
                // Committed: handed over here, as `assign` hands its mail over.
                if let Some(run) = &run {
                    run.hand(queued);
                }
                Ok::<_, Granting>(response)
            })
            .await
            .map_err(|err| Sending::Internal(err.to_string()))??;
        Ok::<_, Granting>(response)
    };
    match made.await {
        Ok(response) => axum::Json(response).into_response(),
        Err(err) => granting(err),
    }
}

/// The unassign as the TypeScript daemon keeps it under its key.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct KeptUnassign<'a> {
    caller: Option<&'a str>,
    task_id: &'a str,
    assignment_id: &'a str,
}

/// `POST /v1/tasks/:id/unassign`: takes an assignment away, and with it every one granted under
/// it. Its agent is told, and so is each agent under it; the subtasks it held move up.
pub(crate) async fn unassign(
    State(shared): State<Shared>,
    caller: Option<Extension<Caller>>,
    Path(id): Path<String>,
    body: Bytes,
) -> Response {
    let unassigned = async {
        let req =
            edge::<UnassignTaskRequest>(&body).map_err(|refused| Sending::Invalid(refused.0))?;
        let agents = shared.agents.clone().ok_or(Sending::Unavailable)?;
        let task = TaskId::parse(&id).ok_or_else(|| Granting::NoTask(id.clone()))?;
        let assignment = AssignmentId::parse(&req.assignment_id)
            .ok_or_else(|| Sending::Invalid(format!("no assignment {}", req.assignment_id)))?;
        let caller = caller_of(caller);
        let run = std::sync::Arc::clone(&agents);
        let (response, queued) = shared
            .store
            .run(move |store| {
                let kept = serde_json::to_string(&KeptUnassign {
                    caller: caller.as_ref().map(AgentId::as_str),
                    task_id: task.as_str(),
                    assignment_id: assignment.as_str(),
                })?;
                let mut queued = Vec::new();
                let response = store.once(&req.idempotency_key, &kept, |w| {
                    let taking = Taking {
                        caller: caller.as_ref(),
                        task: &task,
                        assignment: &assignment,
                    };
                    taking.record(w, run.harnesses(), &mut queued)
                })?;
                Ok::<_, Granting>((response, queued))
            })
            .await
            .map_err(|err| Sending::Internal(err.to_string()))??;
        agents.hand(queued);
        Ok::<_, Granting>(response)
    };
    match unassigned.await {
        Ok(response) => axum::Json(response).into_response(),
        Err(err) => granting(err),
    }
}

/// An assignment a verb takes away, from its task.
struct Taking<'a> {
    caller: Option<&'a AgentId>,
    task: &'a TaskId,
    assignment: &'a AssignmentId,
}

impl Taking<'_> {
    /// Ends the assignment, tells its agent and each agent whose assignment ended with it, then
    /// moves up the subtasks that leaves stranded (`unassign`).
    fn record(
        &self,
        w: &StoreWriter<'_>,
        harnesses: &Harnesses,
        queued: &mut Vec<Queued>,
    ) -> Result<TaskCommandResponse, Granting> {
        let reads = w.reads();
        check_caller(reads, self.caller)?;
        let no_task = || Granting::NoTask(self.task.as_str().to_owned());
        let view = reads.task_view(self.task)?.ok_or_else(no_task)?;
        let granters = reads.granters(self.assignment)?;
        check_unassign(&view, self.caller, self.assignment, &granters)?;
        let target = view
            .active
            .iter()
            .find(|a| a.id == *self.assignment)
            .map(|a| a.agent_id.clone());
        let under = reads.active_under(std::slice::from_ref(self.assignment))?;
        let ended = w.end_assignment(
            self.caller,
            self.assignment,
            AssignmentEndedReason::Unassigned,
        )?;
        let task = reads.task(self.task)?.ok_or_else(no_task)?;
        let caller_name = name_of(reads, self.caller)?;
        let from = self.caller.map(|id| Agent {
            id,
            name: &caller_name,
        });
        let mut to: Vec<Tell> = target
            .into_iter()
            .map(|agent| Tell {
                body: unassigned_mail(&task, from),
                agent,
            })
            .collect();
        for a in under {
            let on = reads.task(&a.task_id)?.ok_or_else(no_task)?;
            to.push(Tell {
                body: line_ended_mail(&on),
                agent: a.agent_id,
            });
        }
        let mut event_ids = vec![ended];
        event_ids.extend(tell(w, harnesses, to, self.caller, queued)?);
        let lifted = lift_stranded(w, harnesses, queued)?;
        if lifted.outran {
            return Err(Sending::Internal(
                "subtasks were still stranded after lifting every level".to_owned(),
            )
            .into());
        }
        event_ids.extend(lifted.event_ids);
        Ok(TaskCommandResponse { event_ids })
    }
}

/// Mail a verb sends one agent.
pub(crate) struct Tell {
    pub(crate) agent: AgentId,
    pub(crate) body: String,
}

/// Mails each agent but the caller its body (`tellEach`), in the verb's write: a retry of the verb
/// replays its answer and sends nothing again, so the mail needs no key of its own, and a later
/// write that tells the same agent the same thing tells it again. An agent that can't take mail
/// now, gone or one whose harness takes none, goes untold: the verb already happened, and the
/// dashboard shows it.
pub(crate) fn tell(
    w: &StoreWriter<'_>,
    harnesses: &Harnesses,
    to: Vec<Tell>,
    caller: Option<&AgentId>,
    fresh: &mut Vec<Queued>,
) -> Result<Vec<u64>, Sending> {
    let mut event_ids = Vec::new();
    for one in to {
        if caller == Some(&one.agent) {
            continue;
        }
        match queue(w, harnesses, &one.agent, &one.body, None, fresh) {
            Ok(sent) => event_ids.extend(sent.event_ids),
            Err(Sending::NoAgent(_) | Sending::Gone { .. }) => {}
            Err(err) => return Err(err),
        }
    }
    Ok(event_ids)
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
    under: Under<'a>,
}

/// The assignment a grant is made under.
enum Under<'a> {
    /// The one the caller grants from, as the grant is checked.
    Checked,
    /// An agent's subtask's, made under `parent`: the assignment on the parent it was delegated
    /// from, or none, made as the parent's owner. The role must be one its standing on the parent
    /// grants, as delegating it would be: it owns the new task, where it would grant more.
    Delegated { parent: &'a TaskId, by: &'a AgentId },
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
        let delegated = match self.under {
            Under::Checked => None,
            Under::Delegated { parent, by } => {
                let parent = reads.task_view(parent)?.ok_or_else(no_task)?;
                Some(check_delegate(&parent, by, self.role, self.book)?)
            }
        };
        let checked = check_grant(&view, self.caller, &agent, self.role, self.book, held)?;
        let parent = delegated.unwrap_or(checked);
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
pub(crate) fn reachable(reads: Reads<'_>, agent: &AgentId) -> rusqlite::Result<bool> {
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

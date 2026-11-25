//! A task's and an assignment's lifecycles, and who may do what to a task, as packages/core's
//! task.ts has them: a task is open until done or cancelled, and an assignment active until it
//! ends, for whichever reason. Each end is final. The checks read a [`TaskView`] the store gives,
//! and either refuse the command or say what it acts from.

use bazhen_protocol::ids::{AgentId, AssignmentId, TaskId};
use bazhen_protocol::names::Role;
use bazhen_protocol::tasks::{AssignmentEndReason, AssignmentState, TaskOutcome, TaskState};

use crate::machine::InvalidTransition;
use crate::roles::RoleBook;

/// The state finishing a task in `from` with `outcome` leads to.
///
/// # Errors
///
/// [`InvalidTransition`] when the task is already finished.
pub fn next(from: TaskState, outcome: TaskOutcome) -> Result<TaskState, InvalidTransition> {
    match (from, outcome) {
        (TaskState::Open, TaskOutcome::Done) => Ok(TaskState::Done),
        (TaskState::Open, TaskOutcome::Cancelled) => Ok(TaskState::Cancelled),
        (TaskState::Done | TaskState::Cancelled, _) => Err(InvalidTransition {
            machine: "task",
            from: from.as_str(),
            event: outcome.as_str(),
        }),
    }
}

/// Whether a task in `state` is finished.
pub fn is_final(state: TaskState) -> bool {
    state != TaskState::Open
}

/// The state ending an assignment in `from` for `reason` leads to.
///
/// # Errors
///
/// [`InvalidTransition`] when the assignment has already ended.
pub fn next_assignment(
    from: AssignmentState,
    reason: AssignmentEndReason,
) -> Result<AssignmentState, InvalidTransition> {
    match from {
        AssignmentState::Active => Ok(AssignmentState::Ended),
        AssignmentState::Ended => Err(InvalidTransition {
            machine: "assignment",
            from: from.as_str(),
            event: reason.as_str(),
        }),
    }
}

/// Whether an assignment in `state` has ended.
pub fn assignment_is_final(state: AssignmentState) -> bool {
    state == AssignmentState::Ended
}

/// Who a command comes from: an agent, by its id, or the human, as `None`.
pub type Caller<'a> = Option<&'a AgentId>;

/// An assignment still active on a task.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveAssignment {
    pub id: AssignmentId,
    pub agent_id: AgentId,
    pub role: Role,
    pub parent_assignment_id: Option<AssignmentId>,
}

/// An open or finished task, with the assignments still active on it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TaskView {
    pub state: TaskState,
    pub owner_agent_id: Option<AgentId>,
    /// Whether the owner still holds what made it the owner. A subtask an agent delegated is its
    /// owner's only while the assignment it was delegated under is active, or, delegated as the
    /// parent's owner, while it still owns the parent; until it moves up, it gives no authority.
    pub owner_holds: bool,
    pub active: Vec<ActiveAssignment>,
    /// Its subtasks still open, which keep it from finishing unless they are cancelled with it.
    pub open_subtasks: Vec<TaskId>,
}

/// Why a command on a task is refused: the caller may not do it, or nobody may while the task is
/// as it is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Refusal {
    Forbidden,
    Conflict,
}

/// A command on a task refused, with what the caller is told.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct TaskRefused {
    pub refusal: Refusal,
    pub message: String,
}

fn forbidden(message: impl Into<String>) -> TaskRefused {
    TaskRefused {
        refusal: Refusal::Forbidden,
        message: message.into(),
    }
}

fn conflict(message: impl Into<String>) -> TaskRefused {
    TaskRefused {
        refusal: Refusal::Conflict,
        message: message.into(),
    }
}

/// The role an agent that owns a task grants as, without holding it.
const OWNER_GRANTS_AS: &str = "coordinator";

/// Whether `caller` is the task's agent owner, with the authority owning it gives.
fn owns(view: &TaskView, caller: Caller<'_>) -> bool {
    caller.is_some() && view.owner_holds && view.owner_agent_id.as_ref() == caller
}

/// The assignment a caller grants from on a task, or `None` for the human. The agent that created
/// the task grants as its coordinator would, without holding the role.
///
/// # Errors
///
/// Forbidden when an agent caller neither holds a role on the task that grants anything nor owns
/// it.
pub fn granting_assignment<'v>(
    view: &'v TaskView,
    caller: Caller<'_>,
    roles: &RoleBook,
) -> Result<Option<&'v ActiveAssignment>, TaskRefused> {
    let Some(agent) = caller else {
        return Ok(None);
    };
    let held: Vec<&ActiveAssignment> = view
        .active
        .iter()
        .filter(|a| a.agent_id == *agent && !roles.rules(&a.role).grants.is_empty())
        .collect();
    let strongest = held
        .iter()
        .find(|a| a.role.as_str() == OWNER_GRANTS_AS)
        .or_else(|| held.first());
    if let Some(&strongest) = strongest {
        return Ok(Some(strongest));
    }
    if owns(view, caller) {
        return Ok(None);
    }
    Err(forbidden(
        "only the task's coordinator, lead or owner can assign it",
    ))
}

/// Checks that `caller` may hand the role on from the open task, and returns what it grants from.
fn check_hand_on<'v>(
    view: &'v TaskView,
    caller: Caller<'_>,
    role: &Role,
    roles: &RoleBook,
) -> Result<Option<&'v ActiveAssignment>, TaskRefused> {
    if view.state != TaskState::Open {
        return Err(conflict(format!("the task is {}", view.state.as_str())));
    }
    let from = granting_assignment(view, caller, roles)?;
    // Only the human makes a coordinator, unless a user's own role file says otherwise.
    let grantable = match (caller, from) {
        (None, _) => roles.get(role).is_some(),
        (Some(_), Some(from)) => roles.rules(&from.role).grants.contains(role),
        (Some(_), None) => roles.rules_of(OWNER_GRANTS_AS).grants.contains(role),
    };
    if !grantable {
        return Err(forbidden(format!(
            "{} can't make an agent {}",
            caller_name(caller),
            role.as_str()
        )));
    }
    Ok(from)
}

/// Checks that the agent may delegate part of `parent` as a subtask, with the role, and returns
/// the assignment the subtask's assignee is delegated from. Its authority comes from the parent:
/// the subtask is new and the delegating agent owns it, which would otherwise let a worker hand
/// on what it was given.
///
/// # Errors
///
/// Conflict when the parent isn't open; forbidden when the agent may not hand the role on from it.
pub fn check_delegate(
    parent: &TaskView,
    caller: &AgentId,
    role: &Role,
    roles: &RoleBook,
) -> Result<Option<AssignmentId>, TaskRefused> {
    Ok(check_hand_on(parent, Some(caller), role, roles)?.map(|from| from.id.clone()))
}

/// How many tasks an agent already holds a role on, which the role may limit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TasksHeld(pub u64);

/// Checks that `caller` may give `agent` the role on the task, and returns the assignment the new
/// one is delegated from: `None` when the human or the task's owner grants it. `held` is how many
/// tasks the agent already holds that role on.
///
/// # Errors
///
/// Forbidden when the caller may not hand the role on; conflict when the task isn't open, the
/// agent is already on it, the role is single and held, or the agent holds the role on as many
/// tasks as it may.
pub fn check_grant(
    view: &TaskView,
    caller: Caller<'_>,
    agent: &AgentId,
    role: &Role,
    roles: &RoleBook,
    TasksHeld(held): TasksHeld,
) -> Result<Option<AssignmentId>, TaskRefused> {
    let from = check_hand_on(view, caller, role, roles)?;
    if view.active.iter().any(|a| a.agent_id == *agent) {
        return Err(conflict(format!("{agent} is already assigned to the task")));
    }
    let limits = roles.rules(role);
    let key = role.as_str();
    if let Some(holder) = view
        .active
        .iter()
        .find(|a| limits.single_per_task && a.role.as_str() == key)
    {
        return Err(conflict(format!(
            "{} is already the task's {key}",
            holder.agent_id
        )));
    }
    if let Some(most) = limits.max_active_tasks
        && held >= most
    {
        let tasks = if held == 1 { "task" } else { "tasks" };
        return Err(conflict(format!(
            "{agent} already works on {held} {tasks} as a {key}, the most a {key} may at once: \
             finish or unassign one first"
        )));
    }
    Ok(from.map(|from| from.id.clone()))
}

/// Checks that `caller` may take the assignment away: the human, the task's owner, or an agent
/// the assignment was granted under, however far up: a coordinator reaches the workers its leads
/// granted. `granters` are the agents of the assignment's ancestors, nearest first.
///
/// # Errors
///
/// Conflict when the assignment isn't active; forbidden when the caller is none of those.
pub fn check_unassign(
    view: &TaskView,
    caller: Caller<'_>,
    assignment: &AssignmentId,
    granters: &[AgentId],
) -> Result<(), TaskRefused> {
    if !view.active.iter().any(|a| a.id == *assignment) {
        return Err(conflict(format!("{assignment} is not active")));
    }
    match caller {
        None => Ok(()),
        Some(agent) if owns(view, caller) || granters.contains(agent) => Ok(()),
        Some(_) => Err(forbidden(
            "only an agent it was granted under, the owner or the human can unassign it",
        )),
    }
}

/// What finishing a task does to its open subtasks: refuses to finish over them, or cancels them
/// with it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Subtasks {
    Refuse,
    CancelWithIt,
}

/// Finishing ends the task, or, for a worker, only the worker's own part in it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Finish<'v> {
    Task,
    Assignment(&'v ActiveAssignment),
}

/// What `caller` finishing the task does. The human, its owner, its coordinator or its lead
/// finishes the task, except that only the human cancels a task the human owns; a worker's
/// `done` completes only its own assignment, since others may still be working on the task. A
/// task with open subtasks finishes only when told to cancel them with it
/// ([`Subtasks::CancelWithIt`]), so no
/// subtask outlives the work it was part of.
///
/// # Errors
///
/// Conflict when the task is finished, or has open subtasks it would refuse; forbidden when an
/// agent cancels the human's task, or the caller neither runs the task nor finishes its own part.
pub fn check_finish<'v>(
    view: &'v TaskView,
    caller: Caller<'_>,
    outcome: TaskOutcome,
    subtasks: Subtasks,
    roles: &RoleBook,
) -> Result<Finish<'v>, TaskRefused> {
    if view.state != TaskState::Open {
        return Err(conflict(format!(
            "the task is already {}",
            view.state.as_str()
        )));
    }
    if outcome == TaskOutcome::Cancelled && view.owner_agent_id.is_none() && caller.is_some() {
        return Err(forbidden("the human's task: only the human cancels it"));
    }
    let mine: Vec<&ActiveAssignment> = view
        .active
        .iter()
        .filter(|a| Some(&a.agent_id) == caller)
        .collect();
    let runs_it = caller.is_none()
        || owns(view, caller)
        || mine.iter().any(|a| !roles.rules(&a.role).grants.is_empty());
    if !runs_it {
        return match mine.first() {
            Some(&own) if outcome == TaskOutcome::Done => Ok(Finish::Assignment(own)),
            _ => Err(forbidden(format!(
                "only its owner, coordinator, lead or the human can mark the task {}",
                outcome.as_str()
            ))),
        };
    }
    if !view.open_subtasks.is_empty() && subtasks == Subtasks::Refuse {
        let open: Vec<&str> = view.open_subtasks.iter().map(TaskId::as_str).collect();
        return Err(conflict(format!(
            "the task has open subtasks ({}): finish them first, or cancel them with it",
            open.join(", ")
        )));
    }
    Ok(Finish::Task)
}

/// Checks that `caller` may note the open task: the human, its owner, or an agent on it.
///
/// # Errors
///
/// Conflict when the task isn't open; forbidden when the caller is none of those.
pub fn check_note(view: &TaskView, caller: Caller<'_>) -> Result<(), TaskRefused> {
    if view.state != TaskState::Open {
        return Err(conflict(format!("the task is {}", view.state.as_str())));
    }
    let on_it = |agent: &AgentId| view.active.iter().any(|a| a.agent_id == *agent);
    if caller.is_none_or(|agent| owns(view, caller) || on_it(agent)) {
        return Ok(());
    }
    Err(forbidden(
        "only an agent on the task, its owner or the human notes it",
    ))
}

fn caller_name(caller: Caller<'_>) -> String {
    caller.map_or_else(|| "the human".to_owned(), |agent| format!("agent {agent}"))
}

#[cfg(test)]
mod tests;

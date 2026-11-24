//! A task's and an assignment's lifecycles, as packages/core's task.ts has them: a task is open
//! until done or cancelled, and an assignment active until it ends, for whichever reason. Each
//! end is final.

use bazhen_protocol::tasks::{AssignmentEndReason, AssignmentState, TaskOutcome, TaskState};

use crate::machine::InvalidTransition;

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

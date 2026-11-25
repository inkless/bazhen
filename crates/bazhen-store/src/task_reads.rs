//! What the task verbs read of tasks and assignments to decide and to tell, as the TypeScript
//! store's task reads (`apps/daemon/src/store/store.ts`) read them: a task as its checks see it,
//! a task in full, the line an assignment was granted under, what is active under one, what
//! stands above a task, its open subtasks, and the subtasks whose owner no longer holds them.
//!
//! The recursive walks end because a parent id only ever names a row that exists when its child
//! is written, and never changes after: no chain of parents can loop.

use bazhen_core::task::{ActiveAssignment, TaskView};
use bazhen_protocol::ids::{AgentId, AssignmentId, TaskId};
use bazhen_protocol::tasks::{Assignment, Task, TaskDetail, TaskNote, TaskState};
use serde::Deserialize;

use crate::events::Reads;
use crate::snapshot::read_rows;
use serde::de::DeserializeOwned;

/// An open subtask whose agent owner no longer holds what made it the owner: the assignment it
/// was delegated under ended, or, delegated as the parent's owner, the parent is no longer its.
const STRANDED: &str = "t.state = 'open' AND t.owner_agent_id IS NOT NULL
  AND t.parent_task_id IS NOT NULL
  AND (
    (t.delegated_from IS NOT NULL
      AND (SELECT state FROM assignments WHERE id = t.delegated_from) = 'ended')
    OR (t.delegated_from IS NULL AND t.owner_agent_id IS NOT
      (SELECT owner_agent_id FROM tasks WHERE id = t.parent_task_id))
  )";

const ASSIGNMENT: &str = "SELECT id, task_id AS taskId, agent_session_id AS agentId, role,
    parent_assignment_id AS parentAssignmentId, state, end_reason AS endReason FROM assignments";

const TASK: &str = "SELECT id, title, state, owner_agent_id AS ownerAgentId,
    parent_task_id AS parentTaskId FROM tasks";

const NOTE: &str = "SELECT n.event_id AS eventId, n.task_id AS taskId,
    n.agent_session_id AS agentId, n.author_role AS role, n.text, n.handoff, e.ts AS at
    FROM task_notes n JOIN events e ON e.id = n.event_id";

/// A task read that failed.
#[derive(Debug, thiserror::Error)]
pub enum TaskReadError {
    #[error("a stored row doesn't read as the protocol's: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// A subtask whose owner no longer holds it, with the owner it moves up to: its parent's, and
/// what made that one the parent's owner.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Stranded {
    pub task_id: TaskId,
    pub owner_agent_id: Option<AgentId>,
    pub delegated_from: Option<AssignmentId>,
}

#[derive(Deserialize)]
struct AgentRow {
    agent: AgentId,
}

#[derive(Deserialize)]
struct TaskRow {
    id: TaskId,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ViewRow {
    state: TaskState,
    owner_agent_id: Option<AgentId>,
    stranded: Option<i64>,
}

/// A task's row with its brief and note, read in the one statement.
#[derive(Deserialize)]
struct DetailRow {
    #[serde(flatten)]
    task: Task,
    brief: String,
    note: Option<String>,
}

impl Reads<'_> {
    /// Task `task` with its active assignments, for deciding whether a command on it is allowed,
    /// or `None` for no such task. Its reads are several statements, so a verb calls it inside
    /// the writer's transaction, where no other write lands between them.
    ///
    /// # Errors
    ///
    /// [`TaskReadError`] when a row doesn't read as the protocol's, or `SQLite` fails.
    pub fn task_view(self, task: &TaskId) -> Result<Option<TaskView>, TaskReadError> {
        let sql = format!(
            "SELECT t.state, t.owner_agent_id AS ownerAgentId, ({STRANDED}) AS stranded
             FROM tasks t WHERE t.id = ?"
        );
        let Some(row) = rows::<ViewRow>(self.0, &sql, [task.as_str()])?
            .into_iter()
            .next()
        else {
            return Ok(None);
        };
        let open_subtasks: Vec<TaskRow> = rows(
            self.0,
            "SELECT id FROM tasks WHERE parent_task_id = ? AND state = 'open'
             ORDER BY created_event_id",
            [task.as_str()],
        )?;
        let active: Vec<Assignment> = rows(
            self.0,
            &format!(
                "{ASSIGNMENT} WHERE task_id = ? AND state = 'active' ORDER BY created_event_id"
            ),
            [task.as_str()],
        )?;
        Ok(Some(TaskView {
            state: row.state,
            owner_agent_id: row.owner_agent_id,
            owner_holds: row.stranded != Some(1),
            active: active.into_iter().map(active_of).collect(),
            open_subtasks: open_subtasks.into_iter().map(|t| t.id).collect(),
        }))
    }

    /// Task `task` in full: its brief and note, every assignment it has had, its subtasks and its
    /// notes, oldest first; `None` for no such task. It reads in a transaction of its own, so it
    /// is called outside any other.
    ///
    /// # Errors
    ///
    /// [`TaskReadError`] when a row doesn't read as the protocol's, or `SQLite` fails, as it does
    /// when the connection is already in a transaction.
    pub fn task_detail(self, task: &TaskId) -> Result<Option<TaskDetail>, TaskReadError> {
        // Every statement reads one snapshot of the database: the writer, on another thread, may
        // finish the task between two of them, which would show it open beside assignments its
        // finish ended. The transaction is only read, and rolled back when it drops.
        let tx = self.0.unchecked_transaction()?;
        let id = task.as_str();
        let task_row = "SELECT id, title, state, owner_agent_id AS ownerAgentId,
            parent_task_id AS parentTaskId, brief, note FROM tasks WHERE id = ?";
        let Some(row) = rows::<DetailRow>(&tx, task_row, [id])?.into_iter().next() else {
            return Ok(None);
        };
        Ok(Some(TaskDetail {
            id: row.task.id,
            title: row.task.title,
            state: row.task.state,
            owner_agent_id: row.task.owner_agent_id,
            parent_task_id: row.task.parent_task_id,
            brief: row.brief,
            note: row.note,
            assignments: rows(
                &tx,
                &format!("{ASSIGNMENT} WHERE task_id = ? ORDER BY created_event_id"),
                [id],
            )?,
            subtasks: rows(
                &tx,
                &format!("{TASK} WHERE parent_task_id = ? ORDER BY created_event_id"),
                [id],
            )?,
            notes: rows(
                &tx,
                &format!("{NOTE} WHERE n.task_id = ? ORDER BY n.event_id"),
                [id],
            )?,
        }))
    }

    /// The latest handoff note on the task written since it was last granted, which the brief of
    /// the next grant carries. One written before that grant was for that assignee, and is not
    /// handed on to every later one.
    ///
    /// # Errors
    ///
    /// [`TaskReadError`] when a row doesn't read as the protocol's, or `SQLite` fails.
    pub fn pending_handoff(self, task: &TaskId) -> Result<Option<TaskNote>, TaskReadError> {
        let notes: Vec<TaskNote> = rows(
            self.0,
            &format!(
                "{NOTE} WHERE n.task_id = ?1 AND n.handoff = 1 AND n.event_id > coalesce(
                   (SELECT max(created_event_id) FROM assignments WHERE task_id = ?1), 0)
                 ORDER BY n.event_id DESC LIMIT 1"
            ),
            [task.as_str()],
        )?;
        Ok(notes.into_iter().next())
    }

    /// The open subtasks whose owner no longer holds them, oldest first, each with the owner it
    /// moves up to.
    ///
    /// # Errors
    ///
    /// [`TaskReadError`] when a row doesn't read as the protocol's, or `SQLite` fails.
    pub fn stranded(self) -> Result<Vec<Stranded>, TaskReadError> {
        rows(
            self.0,
            &format!(
                "SELECT t.id AS taskId, p.owner_agent_id AS ownerAgentId,
                        p.delegated_from AS delegatedFrom
                 FROM tasks t JOIN tasks p ON p.id = t.parent_task_id WHERE {STRANDED}
                 ORDER BY t.created_event_id"
            ),
            (),
        )
    }

    /// The agents with standing on a task or any task above it: each one's owner, coordinator
    /// and lead. Delegating to one of them would hand work back up.
    ///
    /// # Errors
    ///
    /// [`TaskReadError`] when a row doesn't read as the protocol's, or `SQLite` fails.
    pub fn above_on_tree(self, task: &TaskId) -> Result<Vec<AgentId>, TaskReadError> {
        let rows: Vec<AgentRow> = rows(
            self.0,
            "WITH RECURSIVE up (id, parent) AS (
               SELECT id, parent_task_id FROM tasks WHERE id = ?
               UNION ALL
               SELECT t.id, t.parent_task_id FROM tasks t JOIN up ON t.id = up.parent
             )
             SELECT owner_agent_id AS agent FROM tasks WHERE id IN (SELECT id FROM up)
               AND owner_agent_id IS NOT NULL
             UNION
             SELECT agent_session_id FROM assignments WHERE task_id IN (SELECT id FROM up)
               AND state = 'active' AND role IN ('coordinator', 'lead')",
            [task.as_str()],
        )?;
        Ok(rows.into_iter().map(|r| r.agent).collect())
    }

    /// The agents assignment `assignment` was granted under, nearest first, up through every
    /// task.
    ///
    /// # Errors
    ///
    /// [`TaskReadError`] when a row doesn't read as the protocol's, or `SQLite` fails.
    pub fn granters(self, assignment: &AssignmentId) -> Result<Vec<AgentId>, TaskReadError> {
        let rows: Vec<AgentRow> = rows(
            self.0,
            "WITH RECURSIVE up (id, parent, agent, depth) AS (
               SELECT id, parent_assignment_id, agent_session_id, 0 FROM assignments WHERE id = ?
               UNION ALL
               SELECT a.id, a.parent_assignment_id, a.agent_session_id, up.depth + 1
                 FROM assignments a JOIN up ON a.id = up.parent
             )
             SELECT agent FROM up WHERE depth > 0 ORDER BY depth",
            [assignment.as_str()],
        )?;
        Ok(rows.into_iter().map(|r| r.agent).collect())
    }

    /// The active assignments granted under any of `assignments`, however deep, oldest first.
    ///
    /// # Errors
    ///
    /// [`TaskReadError`] when a row doesn't read as the protocol's, or `SQLite` fails.
    pub fn active_under(
        self,
        assignments: &[AssignmentId],
    ) -> Result<Vec<Assignment>, TaskReadError> {
        if assignments.is_empty() {
            return Ok(Vec::new());
        }
        let marks = vec!["?"; assignments.len()].join(", ");
        rows(
            self.0,
            &format!(
                "WITH RECURSIVE under (id) AS (
                   SELECT id FROM assignments WHERE parent_assignment_id IN ({marks})
                   UNION
                   SELECT a.id FROM assignments a JOIN under ON a.parent_assignment_id = under.id
                 )
                 {ASSIGNMENT} WHERE state = 'active' AND id IN (SELECT id FROM under)
                 ORDER BY created_event_id"
            ),
            rusqlite::params_from_iter(assignments.iter().map(AssignmentId::as_str)),
        )
    }

    /// A task's open subtasks, however deep, the deepest first, so each can finish before its
    /// parent.
    ///
    /// # Errors
    ///
    /// [`TaskReadError`] when a row doesn't read as the protocol's, or `SQLite` fails.
    pub fn open_subtasks_under(self, task: &TaskId) -> Result<Vec<TaskId>, TaskReadError> {
        let rows: Vec<TaskRow> = rows(
            self.0,
            "WITH RECURSIVE down (id, depth) AS (
               SELECT id, 1 FROM tasks WHERE parent_task_id = ?
               UNION ALL
               SELECT t.id, down.depth + 1 FROM tasks t JOIN down ON t.parent_task_id = down.id
             )
             SELECT d.id FROM down d JOIN tasks t ON t.id = d.id WHERE t.state = 'open'
             ORDER BY d.depth DESC, t.created_event_id",
            [task.as_str()],
        )?;
        Ok(rows.into_iter().map(|r| r.id).collect())
    }

    /// Agent `agent`'s active assignments, oldest first: the roles it holds, which a role's limit
    /// counts.
    ///
    /// # Errors
    ///
    /// [`TaskReadError`] when a row doesn't read as the protocol's, or `SQLite` fails.
    pub fn active_assignments_of(self, agent: &AgentId) -> Result<Vec<Assignment>, TaskReadError> {
        rows(
            self.0,
            &format!(
                "{ASSIGNMENT} WHERE agent_session_id = ? AND state = 'active'
                 ORDER BY created_event_id"
            ),
            [agent.as_str()],
        )
    }
}

/// Each row `sql` reads, as the type its columns name.
fn rows<T: DeserializeOwned>(
    db: &rusqlite::Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<T>, TaskReadError> {
    read_rows(db, sql, params)
}

fn active_of(a: Assignment) -> ActiveAssignment {
    ActiveAssignment {
        id: a.id,
        agent_id: a.agent_id,
        role: a.role,
        parent_assignment_id: a.parent_assignment_id,
    }
}

#[cfg(test)]
mod tests;

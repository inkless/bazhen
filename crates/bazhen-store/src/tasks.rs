//! Tasks made by request, as `tasks/tasks.ts` makes them: once per idempotency key, and refused
//! under a parent that isn't there or isn't open, or, for an agent, one it has no authority on.

use bazhen_core::roles::RoleBook;
use bazhen_core::task::{TaskRefused, granting_assignment};
use bazhen_protocol::events::TaskCreated;
use bazhen_protocol::ids::{AgentId, AssignmentId, TaskId};
use bazhen_protocol::nullable::Nullable;
use bazhen_protocol::tasks::{CreateTaskResponse, TaskState};
use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::{AppendError, NewEvent, OnceError, Store, TaskReadError, Writer};

/// A task the caller asks for, each field already held to the protocol's rules, its title
/// trimmed: the human's, or an agent's, which owns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewTask {
    pub caller: Option<AgentId>,
    pub key: String,
    pub title: String,
    pub brief: String,
    pub parent: Option<TaskId>,
}

/// The request as the TypeScript daemon keeps it under its key: its fields after the caller, in
/// the order its schema lists them, the key itself left out.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Kept<'a> {
    caller: Option<&'a str>,
    title: &'a str,
    brief: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    parent_task_id: Option<&'a str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    assign: Option<&'a Assigning<'a>>,
}

/// The role a request to make a task asks to grant on it, as the request keeps it: the agent as
/// resolved, and the role. The grant itself is the caller's to make, in the same write.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Assigning<'a> {
    pub agent_id: &'a str,
    pub role: &'a str,
}

/// A task just made, in the write that made it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MadeTask {
    pub task_id: TaskId,
    /// The `task.created` event's id.
    pub event: u64,
    /// For an agent's subtask, the assignment on the parent it delegates under; none for one it
    /// makes as the parent's owner, or the human's.
    pub delegated_from: Option<AssignmentId>,
}

impl NewTask {
    /// The text a repeat of this request must match, as the TypeScript daemon writes it, so a key
    /// either daemon recorded replays in the other.
    ///
    /// # Errors
    ///
    /// `serde_json`'s, which a struct of strings never meets.
    pub fn request_text(&self) -> serde_json::Result<String> {
        self.request_text_assigning(None)
    }

    /// The text a repeat of this request must match when it also asks for `assign`.
    ///
    /// # Errors
    ///
    /// `serde_json`'s, which a struct of strings never meets.
    pub fn request_text_assigning(
        &self,
        assign: Option<&Assigning<'_>>,
    ) -> serde_json::Result<String> {
        serde_json::to_string(&Kept {
            caller: self.caller.as_ref().map(AgentId::as_str),
            title: &self.title,
            brief: &self.brief,
            parent_task_id: self.parent.as_ref().map(TaskId::as_str),
            assign,
        })
    }
}

/// Why a task wasn't made.
#[derive(Debug, thiserror::Error)]
pub enum CreateTaskError {
    #[error("no task {0}")]
    NoParent(String),
    /// The calling agent is gone, or was never there.
    #[error("no agent {0} that is open")]
    NoCaller(String),
    /// The parent is done or cancelled.
    #[error("the parent task is {0}")]
    ParentClosed(String),
    /// An agent's subtask under a parent it neither owns nor holds a role on that grants.
    #[error(transparent)]
    Refused(TaskRefused),
    #[error(transparent)]
    Read(#[from] TaskReadError),
    #[error(transparent)]
    Once(#[from] OnceError),
    #[error(transparent)]
    Append(#[from] AppendError),
    #[error("can't mint a task id: {0}")]
    Random(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

impl Store {
    /// Makes `task` for its caller, or answers what its key was first answered. An agent that
    /// can't act, closing or gone, makes none.
    ///
    /// # Errors
    ///
    /// [`CreateTaskError`]; nothing is recorded then.
    pub fn create_task(
        &mut self,
        task: &NewTask,
        book: &RoleBook,
    ) -> Result<CreateTaskResponse, CreateTaskError> {
        self.once(&task.key, &task.request_text()?, |w| {
            let made = w.create_task(task, book)?;
            Ok(CreateTaskResponse {
                task_id: made.task_id,
                assignment_id: None,
                event_ids: vec![made.event],
            })
        })
    }
}

impl Writer<'_> {
    /// Makes `task` in this write, as `create` does before any grant (`tasks.ts`). An agent's
    /// subtask is a delegation, which needs the authority delegating would: it is made under the
    /// assignment on the parent that grants, which `granting_assignment` picks, and is refused
    /// one where the agent has none and doesn't own the parent.
    ///
    /// # Errors
    ///
    /// [`CreateTaskError`]; the write is rolled back then.
    pub fn create_task(
        &self,
        task: &NewTask,
        book: &RoleBook,
    ) -> Result<MadeTask, CreateTaskError> {
        if let Some(caller) = &task.caller
            && !open(self, caller)?
        {
            return Err(CreateTaskError::NoCaller(caller.as_str().to_owned()));
        }
        let mut delegated_from = None;
        if let Some(parent) = &task.parent {
            let view = self
                .reads()
                .task_view(parent)?
                .ok_or_else(|| CreateTaskError::NoParent(parent.as_str().to_owned()))?;
            if view.state != TaskState::Open {
                return Err(CreateTaskError::ParentClosed(
                    view.state.as_str().to_owned(),
                ));
            }
            delegated_from = granting_assignment(&view, task.caller.as_ref(), book)
                .map_err(CreateTaskError::Refused)?
                .map(|from| from.id.clone());
        }
        let id = TaskId::mint(crate::now_ms(), crate::urandom()?);
        let event = self.append(&NewEvent::TaskCreated {
            task: id.clone(),
            actor: task
                .caller
                .as_ref()
                .map_or("human", AgentId::as_str)
                .to_owned(),
            payload: TaskCreated {
                title: task.title.clone(),
                brief: task.brief.clone(),
                owner_agent_id: task.caller.clone(),
                parent_task_id: task.parent.clone(),
                delegated_from: delegated_from
                    .clone()
                    .map_or(Nullable::Null, Nullable::Value),
            },
        })?;
        Ok(MadeTask {
            task_id: id,
            event,
            delegated_from,
        })
    }
}

/// Whether `agent` can act: it is known, and not closing or gone, as `checkCaller` has it.
pub(crate) fn open(w: &Writer<'_>, agent: &AgentId) -> rusqlite::Result<bool> {
    let state: Option<String> = w
        .connection()
        .query_row(
            "SELECT state FROM agent_sessions WHERE id = ?",
            [agent.as_str()],
            |row| row.get(0),
        )
        .optional()?;
    Ok(state
        .as_deref()
        .is_some_and(|s| !matches!(s, "closing" | "closed" | "failed" | "lost")))
}

#[cfg(test)]
mod tests {
    use serde_json::Value;

    use super::*;
    use crate::testing::TempDir;

    fn fixture() -> Value {
        let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../packages/protocol/fixtures/store/events.json");
        serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
    }

    fn asked(request: &Value) -> NewTask {
        NewTask {
            caller: None,
            key: request["idempotencyKey"].as_str().unwrap().to_owned(),
            title: request["title"].as_str().unwrap().trim().to_owned(),
            brief: request["brief"].as_str().unwrap().to_owned(),
            parent: request["parentTaskId"]
                .as_str()
                .map(|id| TaskId::parse(id).unwrap()),
        }
    }

    fn kept_request(store: &Store, key: &str) -> String {
        let kept: String = store
            .db
            .query_row(
                "SELECT response FROM idempotency_keys WHERE key = ?",
                [key],
                |row| row.get(0),
            )
            .unwrap();
        let kept: Value = serde_json::from_str(&kept).unwrap();
        kept["request"].as_str().unwrap().to_owned()
    }

    #[test]
    fn keeps_each_request_as_the_typescript_daemon_recorded_it() {
        let log = &fixture()["log"];
        let recorded: Vec<(String, String)> = log["tables"]["idempotency_keys"]
            .as_array()
            .unwrap()
            .iter()
            .map(|row| {
                let kept: Value = serde_json::from_str(row["response"].as_str().unwrap()).unwrap();
                let request = kept["request"].as_str().unwrap().to_owned();
                (row["key"].as_str().unwrap().to_owned(), request)
            })
            .collect();
        for request in log["requests"].as_array().unwrap() {
            let task = asked(request);
            let expected = &recorded.iter().find(|(key, _)| *key == task.key).unwrap().1;
            assert_eq!(task.request_text().unwrap(), *expected);
        }
        let dir = TempDir::new("tasks-kept");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let parent = asked(&log["requests"][0]);
        store
            .create_task(&parent, &RoleBook::new(Vec::new()))
            .unwrap();
        assert_eq!(
            kept_request(&store, &parent.key),
            parent.request_text().unwrap()
        );
    }

    #[test]
    fn makes_a_task_once_per_key_and_refuses_the_key_for_another_request() {
        let dir = TempDir::new("tasks-once");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let task = asked(&fixture()["log"]["requests"][0]);
        let first = store
            .create_task(&task, &RoleBook::new(Vec::new()))
            .unwrap();
        assert_eq!(
            (first.assignment_id.as_ref(), first.event_ids.as_slice()),
            (None, &[1][..])
        );
        assert_eq!(
            store
                .create_task(&task, &RoleBook::new(Vec::new()))
                .unwrap(),
            first
        );
        let other = NewTask {
            brief: "else".to_owned(),
            ..task
        };
        assert!(matches!(
            store.create_task(&other, &RoleBook::new(Vec::new())),
            Err(CreateTaskError::Once(OnceError::Conflict(key))) if key == "create parent"
        ));
        assert_eq!(store.reads().latest_event_id().unwrap(), 1);
    }

    #[test]
    fn refuses_a_parent_that_isnt_there_or_isnt_open_and_records_nothing() {
        let dir = TempDir::new("tasks-parent");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let parent = store
            .create_task(
                &asked(&fixture()["log"]["requests"][0]),
                &RoleBook::new(Vec::new()),
            )
            .unwrap()
            .task_id;
        let under = |key: &str, parent: &TaskId| NewTask {
            caller: None,
            key: key.to_owned(),
            title: "Child".to_owned(),
            brief: "b".to_owned(),
            parent: Some(parent.clone()),
        };
        let missing = TaskId::mint(1, [9; 16]);
        assert!(matches!(
            store.create_task(&under("a", &missing), &RoleBook::new(Vec::new())),
            Err(CreateTaskError::NoParent(id)) if id == missing.as_str()
        ));
        store
            .db
            .execute(
                "UPDATE tasks SET state = 'done' WHERE id = ?",
                [parent.as_str()],
            )
            .unwrap();
        let refused = store.create_task(&under("b", &parent), &RoleBook::new(Vec::new()));
        assert!(
            matches!(refused, Err(CreateTaskError::ParentClosed(ref state)) if state == "done"),
            "{refused:?}"
        );
        assert_eq!(store.reads().latest_event_id().unwrap(), 1);
        let keys: i64 = store
            .db
            .query_row("SELECT count(*) FROM idempotency_keys", (), |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(keys, 1);
    }

    #[test]
    fn makes_an_agents_task_owned_by_it_and_none_for_an_agent_that_cant_act() {
        let dir = TempDir::new("tasks-agent");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let agent =
            |n: char| AgentId::parse(&format!("agent_0190a1b2c3d47abc8def0123456789a{n}")).unwrap();
        store
            .db
            .execute_batch(&format!(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                   SELECT id, '2026-11-20T00:00:00.000Z', 'x', 'x', 'x', 'system', '{{}}' FROM host;
                 INSERT INTO environments (id, kind, created_event_id) VALUES ('env_local', 'local', 1);
                 INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state,
                   created_event_id, updated_event_id) VALUES
                   ('{}', 'env_local', 'claude-code', 'p', '/', 'running', 1, 1),
                   ('{}', 'env_local', 'claude-code', 'p', '/', 'closing', 1, 1),
                   ('{}', 'env_local', 'claude-code', 'p', '/', 'lost', 1, 1);",
                agent('1'),
                agent('2'),
                agent('3'),
            ))
            .unwrap();
        let task = |key: &str, caller| NewTask {
            caller: Some(caller),
            key: key.to_owned(),
            title: "T".to_owned(),
            brief: "b".to_owned(),
            parent: None,
        };
        let made = store
            .create_task(&task("mine", agent('1')), &RoleBook::new(Vec::new()))
            .unwrap();
        let (actor, owner): (String, String) = store
            .db
            .query_row(
                "SELECT e.actor, t.owner_agent_id FROM tasks t JOIN events e ON e.id = t.created_event_id
                 WHERE t.id = ?",
                [made.task_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!([actor.as_str(), owner.as_str()], [agent('1').as_str(); 2]);
        assert_eq!(
            kept_request(&store, "mine"),
            format!(
                r#"{{"caller":"{}","title":"T","brief":"b"}}"#,
                agent('1').as_str()
            )
        );
        for (key, caller) in [
            ("closing", agent('2')),
            ("lost", agent('3')),
            ("unknown", agent('4')),
        ] {
            let refused = store.create_task(&task(key, caller.clone()), &RoleBook::new(Vec::new()));
            assert!(
                matches!(&refused, Err(CreateTaskError::NoCaller(id)) if id == caller.as_str()),
                "{refused:?}"
            );
        }
        assert_eq!(store.reads().latest_event_id().unwrap(), 2);
    }
}

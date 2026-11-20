//! Tasks made by request, as `tasks/tasks.ts` makes them: once per idempotency key, and refused
//! under a parent that isn't there or isn't open.

use bazhen_protocol::events::TaskCreated;
use bazhen_protocol::ids::TaskId;
use bazhen_protocol::tasks::CreateTaskResponse;
use rusqlite::OptionalExtension;
use serde::Serialize;

use crate::{AppendError, NewEvent, OnceError, Store};

/// A task the human asks for, each field already held to the protocol's rules, its title trimmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NewTask {
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
}

impl NewTask {
    /// The text a repeat of this request must match, as the TypeScript daemon writes it, so a key
    /// either daemon recorded replays in the other.
    ///
    /// # Errors
    ///
    /// `serde_json`'s, which a struct of strings never meets.
    pub fn request_text(&self) -> serde_json::Result<String> {
        serde_json::to_string(&Kept {
            caller: None,
            title: &self.title,
            brief: &self.brief,
            parent_task_id: self.parent.as_ref().map(TaskId::as_str),
        })
    }
}

/// Why a task wasn't made.
#[derive(Debug, thiserror::Error)]
pub enum CreateTaskError {
    #[error("no task {0}")]
    NoParent(String),
    /// The parent is done or cancelled.
    #[error("the parent task is {0}")]
    ParentClosed(String),
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
    /// Makes `task` for the human, or answers what its key was first answered.
    ///
    /// # Errors
    ///
    /// [`CreateTaskError`]; nothing is recorded then.
    pub fn create_task(&mut self, task: &NewTask) -> Result<CreateTaskResponse, CreateTaskError> {
        self.once(&task.key, &task.request_text()?, |w| {
            if let Some(parent) = &task.parent {
                let state: Option<String> = w
                    .connection()
                    .query_row(
                        "SELECT state FROM tasks WHERE id = ?",
                        [parent.as_str()],
                        |row| row.get(0),
                    )
                    .optional()?;
                match state.as_deref() {
                    None => return Err(CreateTaskError::NoParent(parent.as_str().to_owned())),
                    Some("open") => {}
                    Some(state) => return Err(CreateTaskError::ParentClosed(state.to_owned())),
                }
            }
            let id = TaskId::mint(crate::now_ms(), crate::urandom()?);
            let created = w.append(&NewEvent::TaskCreated {
                task: id.clone(),
                actor: "human".to_owned(),
                payload: TaskCreated {
                    title: task.title.clone(),
                    brief: task.brief.clone(),
                    owner_agent_id: None,
                    parent_task_id: task.parent.clone(),
                    delegated_from: None,
                },
            })?;
            Ok(CreateTaskResponse {
                task_id: id,
                assignment_id: None,
                event_ids: vec![created],
            })
        })
    }
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
        store.create_task(&parent).unwrap();
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
        let first = store.create_task(&task).unwrap();
        assert_eq!(
            (first.assignment_id.as_ref(), first.event_ids.as_slice()),
            (None, &[1][..])
        );
        assert_eq!(store.create_task(&task).unwrap(), first);
        let other = NewTask {
            brief: "else".to_owned(),
            ..task
        };
        assert!(matches!(
            store.create_task(&other),
            Err(CreateTaskError::Once(OnceError::Conflict(key))) if key == "create parent"
        ));
        assert_eq!(store.reads().latest_event_id().unwrap(), 1);
    }

    #[test]
    fn refuses_a_parent_that_isnt_there_or_isnt_open_and_records_nothing() {
        let dir = TempDir::new("tasks-parent");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let parent = store
            .create_task(&asked(&fixture()["log"]["requests"][0]))
            .unwrap()
            .task_id;
        let under = |key: &str, parent: &TaskId| NewTask {
            key: key.to_owned(),
            title: "Child".to_owned(),
            brief: "b".to_owned(),
            parent: Some(parent.clone()),
        };
        let missing = TaskId::mint(1, [9; 16]);
        assert!(matches!(
            store.create_task(&under("a", &missing)),
            Err(CreateTaskError::NoParent(id)) if id == missing.as_str()
        ));
        store
            .db
            .execute(
                "UPDATE tasks SET state = 'done' WHERE id = ?",
                [parent.as_str()],
            )
            .unwrap();
        let refused = store.create_task(&under("b", &parent));
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
}

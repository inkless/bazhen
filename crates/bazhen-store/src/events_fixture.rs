//! The event log against what `moon run :schema` records of the TypeScript one
//! (packages/protocol/fixtures/store/events.json): the same event types, each streamed with the
//! same keys, the same rows written for the same commands, and the same idempotency answers.

use std::path::{Path, PathBuf};

use bazhen_protocol::events::{EVENT_KINDS, TaskCreated};
use bazhen_protocol::ids::{DeviceId, TaskId};
use bazhen_protocol::tasks::CreateTaskResponse;
use rusqlite::Connection;
use serde_json::Value;

use crate::testing::TempDir;
use crate::{Dismissal, NewDevice, NewEvent, OnceError, Revoked, Store, Viewer};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/fixtures/store/events.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn sql_value(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Number(n) => rusqlite::types::Value::Integer(n.as_i64().unwrap()),
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        other => panic!("unexpected {other}"),
    }
}

/// A database holding the rows the TypeScript daemon wrote, its host's included.
fn written_by_typescript(path: &Path) -> Store {
    drop(Store::open(path).unwrap());
    let db = Connection::open(path).unwrap();
    db.execute_batch("DELETE FROM host; DELETE FROM event_log")
        .unwrap();
    let tables = &fixture()["log"]["tables"];
    let order = [
        "host",
        "event_log",
        "events",
        "tasks",
        "task_notes",
        "devices",
        "notices",
        "idempotency_keys",
    ];
    assert_eq!(tables.as_object().unwrap().len(), order.len());
    for table in order {
        for row in tables[table].as_array().unwrap() {
            let row = row.as_object().unwrap();
            let columns: Vec<&str> = row.keys().map(String::as_str).collect();
            let sql = format!(
                "INSERT INTO {table} ({}) VALUES ({})",
                columns.join(", "),
                vec!["?"; columns.len()].join(", ")
            );
            let values: Vec<_> = row.values().map(sql_value).collect();
            db.execute(&sql, rusqlite::params_from_iter(values))
                .unwrap();
        }
    }
    drop(db);
    Store::open(path).unwrap()
}

fn row(store: &Store, sql: &str) -> Vec<Value> {
    let mut statement = store.db.prepare(sql).unwrap();
    let width = statement.column_count();
    statement
        .query_map((), |row| {
            Ok((0..width)
                .map(|i| match row.get_ref(i).unwrap() {
                    rusqlite::types::ValueRef::Null => Value::Null,
                    rusqlite::types::ValueRef::Integer(n) => n.into(),
                    rusqlite::types::ValueRef::Text(t) => {
                        std::str::from_utf8(t).unwrap().to_owned().into()
                    }
                    other => panic!("unexpected {other:?}"),
                })
                .collect::<Vec<_>>())
        })
        .unwrap()
        .map(|r| Value::Array(r.unwrap()))
        .collect()
}

#[test]
fn registers_every_event_type_the_typescript_daemon_does_streaming_the_same_keys() {
    let registry: Vec<Value> = EVENT_KINDS
        .iter()
        .map(|kind| {
            serde_json::json!({ "type": kind.name, "entity": kind.entity, "streamed": kind.streamed })
        })
        .collect();
    assert_eq!(Value::Array(registry), fixture()["registry"]);
}

#[test]
fn streams_each_event_the_typescript_daemon_wrote_byte_for_byte_as_its_stream_does() {
    let dir = TempDir::new("events-frames");
    let store = written_by_typescript(&dir.db("bazhen.db"));
    let frames: Vec<String> = store
        .reads()
        .events(0, 500)
        .unwrap()
        .iter()
        .map(|event| event.frame().unwrap())
        .collect();
    let expected: Vec<String> = fixture()["log"]["frames"]
        .as_array()
        .unwrap()
        .iter()
        .map(|f| f.as_str().unwrap().to_owned())
        .collect();
    assert_eq!(frames, expected);
    assert!(
        frames
            .iter()
            .all(|f| !f.contains("brief") && !f.contains("half done") && !f.contains("merged")),
        "{frames:?}"
    );
}

#[test]
fn appends_a_task_as_the_typescript_daemon_writes_it_event_and_row() {
    let dir = TempDir::new("events-append");
    let path = dir.db("bazhen.db");
    let typescript = written_by_typescript(&dir.db("typescript.db"));
    {
        let theirs = written_by_typescript(&path);
        theirs
            .db
            .execute_batch(
                "DELETE FROM notices; DELETE FROM devices; DELETE FROM task_notes;
                 DELETE FROM tasks; DELETE FROM events",
            )
            .unwrap();
    }
    let mut store = Store::open(&path).unwrap();
    let request = &fixture()["log"]["requests"][0];
    let task = TaskId::parse(fixture()["log"]["responses"][0]["taskId"].as_str().unwrap()).unwrap();
    let id = store
        .write(|w| {
            w.append(&NewEvent::TaskCreated {
                task,
                actor: "human".to_owned(),
                payload: TaskCreated {
                    title: request["title"].as_str().unwrap().trim().to_owned(),
                    brief: request["brief"].as_str().unwrap().to_owned(),
                    owner_agent_id: None,
                    parent_task_id: None,
                    delegated_from: None,
                },
            })
        })
        .unwrap();
    assert_eq!(id, 1);
    let event = "SELECT id, host_id, type, entity_type, entity_id, actor, causation_id,
                   correlation_id, payload FROM events WHERE id = 1";
    assert_eq!(row(&store, event), row(&typescript, event));
    let task = "SELECT * FROM tasks WHERE created_event_id = 1";
    assert_eq!(row(&store, task), row(&typescript, task));
}

#[test]
fn replays_the_answer_the_typescript_daemon_recorded_for_a_key_and_refuses_it_for_another_request()
{
    let dir = TempDir::new("events-replay");
    let mut store = written_by_typescript(&dir.db("bazhen.db"));
    let kept: Value = serde_json::from_str(
        row(
            &store,
            "SELECT response FROM idempotency_keys WHERE key = 'create child'",
        )[0][0]
            .as_str()
            .unwrap(),
    )
    .unwrap();
    let request = kept["request"].as_str().unwrap();
    let replayed: Value = store
        .once("create child", request, |_| -> Result<Value, OnceError> {
            panic!("a repeat runs nothing")
        })
        .unwrap();
    assert_eq!(replayed, fixture()["log"]["responses"][1]);
    let other = store.once(
        "create child",
        r#"{"caller":null}"#,
        |_| -> Result<Value, OnceError> { panic!("a conflict runs nothing") },
    );
    assert!(matches!(other, Err(OnceError::Conflict(key)) if key == "create child"));
}

#[test]
fn snapshots_the_log_as_the_typescript_daemon_does() {
    let dir = TempDir::new("events-snapshot");
    let store = written_by_typescript(&dir.db("bazhen.db"));
    let snapshot = serde_json::to_value(store.reads().snapshot().unwrap()).unwrap();
    assert_eq!(snapshot, fixture()["log"]["snapshot"]);
}

#[test]
fn refuses_a_snapshot_that_would_leave_out_rows_this_build_cant_describe() {
    let dir = TempDir::new("events-unported");
    let store = written_by_typescript(&dir.db("bazhen.db"));
    store
        .db
        .execute_batch(
            "INSERT INTO environments (id, kind, created_event_id) VALUES ('env_1', 'local', 1);
             INSERT INTO notices (id, kind, state, summary, created_event_id, updated_event_id)
               VALUES ('ntc_1', 'pairing', 'closed', 'paired', 1, 1);",
        )
        .unwrap();
    let refused = store.reads().snapshot();
    assert!(
        matches!(&refused, Err(crate::SnapshotError::Unported(s)) if s == &["environments"]),
        "{refused:?}"
    );
}

#[test]
fn records_an_answer_byte_for_byte_as_the_typescript_daemon_does() {
    let dir = TempDir::new("events-answer");
    let mut store = written_by_typescript(&dir.db("bazhen.db"));
    let key = "SELECT response FROM idempotency_keys WHERE key = 'create parent'";
    let theirs = row(&store, key)[0][0].as_str().unwrap().to_owned();
    let request = serde_json::from_str::<Value>(&theirs).unwrap()["request"]
        .as_str()
        .unwrap()
        .to_owned();
    store
        .db
        .execute("DELETE FROM idempotency_keys", ())
        .unwrap();
    let response: CreateTaskResponse =
        serde_json::from_value(fixture()["log"]["responses"][0].clone()).unwrap();
    let answered = response.clone();
    let first = store
        .once(
            "create parent",
            &request,
            move |_| -> Result<_, OnceError> { Ok(answered) },
        )
        .unwrap();
    assert_eq!(first, response);
    assert_eq!(row(&store, key)[0][0].as_str().unwrap(), theirs);
}

/// Each id this store minted, swapped for the one the TypeScript daemon minted in its place.
fn swapped(rows: &[Value], swaps: &[(String, String)]) -> Vec<Value> {
    let mut text = serde_json::to_string(&rows).unwrap();
    for (ours, theirs) in swaps {
        text = text.replace(ours, theirs);
    }
    serde_json::from_str(&text).unwrap()
}

#[test]
fn pairs_dismisses_and_revokes_as_the_typescript_daemon_writes_it_events_and_rows() {
    let dir = TempDir::new("events-devices");
    let typescript = written_by_typescript(&dir.db("typescript.db"));
    let path = dir.db("bazhen.db");
    let tasks_only = "DELETE FROM idempotency_keys WHERE key = 'dismiss'; DELETE FROM notices;
                      DELETE FROM devices; DELETE FROM events WHERE type NOT LIKE 'task.%'";
    written_by_typescript(&path)
        .db
        .execute_batch(tasks_only)
        .unwrap();
    let mut store = Store::open(&path).unwrap();
    let log = &fixture()["log"];
    let text = |v: &Value| v.as_str().unwrap().to_owned();
    let mut swaps = Vec::new();
    for pairing in log["pairings"].as_array().unwrap() {
        let paired = store
            .pair_device(&NewDevice {
                name: text(&pairing["name"]),
                token_hash: text(&pairing["tokenHash"]),
                secure: pairing["secure"] == true,
                origin: text(&pairing["origin"]),
                address: pairing["address"].as_str().map(str::to_owned),
            })
            .unwrap();
        assert_eq!(paired.name, text(&pairing["name"]));
        swaps.push((
            paired.device_id.as_str().to_owned(),
            text(&pairing["deviceId"]),
        ));
    }
    let ours = row(&store, "SELECT id FROM notices ORDER BY created_event_id");
    let theirs = row(
        &typescript,
        "SELECT id FROM notices ORDER BY created_event_id",
    );
    swaps.extend(
        ours.iter()
            .zip(&theirs)
            .map(|(o, t)| (text(&o[0]), text(&t[0]))),
    );
    let ours_for = |id: &Value| {
        let (ours, _) = swaps.iter().find(|(_, t)| *t == text(id)).unwrap();
        ours.clone()
    };
    let dismissal = &log["dismissal"];
    assert_eq!(dismissal["by"], "owner-socket");
    store
        .dismiss_notice(&Dismissal {
            notice: ours_for(&dismissal["notice"]),
            key: text(&dismissal["idempotencyKey"]),
            by: Viewer::OwnerSocket,
            from_device: DeviceId::parse(&ours_for(&dismissal["fromDevice"])),
        })
        .unwrap();
    let revoked = ours_for(&log["revoked"]);
    assert_eq!(store.revoke_device(&revoked).unwrap(), Revoked::Now);
    assert_eq!(store.revoke_device(&revoked).unwrap(), Revoked::Already);
    for sql in [
        "SELECT id, host_id, type, entity_type, entity_id, actor, causation_id, correlation_id,
           payload FROM events ORDER BY id",
        "SELECT id, name, token_hash, revoked_at IS NULL, secure FROM devices ORDER BY paired_at, name",
        "SELECT * FROM notices ORDER BY created_event_id",
        "SELECT * FROM idempotency_keys WHERE key = 'dismiss'",
    ] {
        assert_eq!(
            swapped(&row(&store, sql), &swaps),
            row(&typescript, sql),
            "{sql}"
        );
    }
}

//! The events of agents, their mail, their items for the human and their tasks, against what
//! `moon run :schema` records of the TypeScript store (packages/protocol/fixtures/agents/events.json):
//! the same run of events appended, each taken or refused as it was there, leaving the same rows
//! in every table they write; and the `/v1/state` snapshot of what they left (snapshot.json),
//! under the same answers to what the snapshot asks of a daemon.

use std::path::PathBuf;

use rusqlite::Connection;
use rusqlite::types::ValueRef;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;
use serde_json::{Map, Value};

use bazhen_protocol::agents::{ActivityValue, HarnessId};
use bazhen_protocol::mail::{AttentionAction, AttentionKind};
use bazhen_protocol::names::Role;
use bazhen_protocol::shells::TuiTheme;

use crate::testing::TempDir;
use crate::{
    Actor, AgentChange, AgentView, AppendError, AssignmentChange, AttentionChange, AttentionView,
    Evidence, Listener, MailChange, NewEvent, OpenAttention, SnapshotView, Store, TaskChange,
    TerminalChange,
};

/// The fixture, each step's payload kept as its text: decoded through a `Value`, whose map sorts
/// its keys, a locator would lose the order the TypeScript daemon wrote it in.
#[derive(Deserialize)]
struct Fixture {
    host: String,
    steps: Vec<Step>,
    tables: Map<String, Value>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Step {
    #[serde(rename = "type")]
    kind: String,
    entity_id: String,
    actor: String,
    payload: Box<RawValue>,
    refused: Option<String>,
}

fn read<T: DeserializeOwned>(name: &str) -> T {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/fixtures/agents")
        .join(name);
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn fixture() -> Fixture {
    read("events.json")
}

/// The snapshot the TypeScript store answered once the fixture's events were appended, every
/// event's time set to `ts` and the store's epoch written as `epoch`.
#[derive(Deserialize)]
struct Snapshotted {
    ts: String,
    epoch: String,
    snapshot: Value,
}

/// The answers the fixture's generator gave the TypeScript store's snapshot.
struct FixtureView;

impl AgentView for FixtureView {
    fn resumes(&self, evidence: &Evidence<'_>) -> bool {
        evidence.transcript.is_some()
    }

    fn themes(&self, harness: HarnessId) -> Vec<TuiTheme> {
        match harness {
            HarnessId::ClaudeCode => vec![TuiTheme::Dark, TuiTheme::Light],
            HarnessId::Codex => vec![TuiTheme::Dark],
        }
    }

    fn listening(&self, agent: &Listener<'_>) -> bool {
        agent.activity == Some(ActivityValue::Idle)
    }

    fn prompt_hash(&self, role: Option<&Role>) -> String {
        format!("hash-{}", role.map_or("none", Role::as_str))
    }
}

impl AttentionView for FixtureView {
    fn attention_actions(&self, item: &OpenAttention<'_>) -> Vec<AttentionAction> {
        use AttentionAction::{Allow, Deny, Dismiss, Reply, Resend};
        match (item.kind, item.main_agent, item.message_id) {
            (AttentionKind::Approval, true, _) => vec![Allow, Deny, Reply],
            (AttentionKind::Approval, false, _) => vec![Allow, Deny],
            (_, _, None) => vec![Dismiss],
            (_, _, Some(_)) => vec![Resend, Dismiss],
        }
    }
}

fn decode<T: DeserializeOwned>(text: &str) -> T {
    serde_json::from_str(text).unwrap_or_else(|e| panic!("{text}: {e}"))
}

/// The change an `agent.*` event of `kind` makes, from the payload the TypeScript store took.
fn change(kind: &str, payload: &str) -> AgentChange {
    match kind {
        "agent.launched" => AgentChange::Launched(decode(payload)),
        "agent.renamed" => AgentChange::Renamed(decode(payload)),
        "agent.running" => AgentChange::Running(decode(payload)),
        "agent.ready" => AgentChange::Ready(decode(payload)),
        "agent.failed" => AgentChange::Failed(decode(payload)),
        "agent.lost" => AgentChange::Lost,
        "agent.process_adopted" => AgentChange::ProcessAdopted(decode(payload)),
        "agent.respawn_requested" => AgentChange::RespawnRequested,
        "agent.respawned" => AgentChange::Respawned(decode(payload)),
        "agent.respawn_rejected" => AgentChange::RespawnRejected(decode(payload)),
        "agent.relaunch_requested" => AgentChange::RelaunchRequested(decode(payload)),
        "agent.relaunched" => AgentChange::Relaunched(decode(payload)),
        "agent.relaunch_rejected" => AgentChange::RelaunchRejected(decode(payload)),
        "agent.external_ref_updated" => AgentChange::ExternalRefUpdated(decode(payload)),
        "agent.transcript_recorded" => AgentChange::TranscriptRecorded(decode(payload)),
        "agent.signalled" => AgentChange::Signalled(decode(payload)),
        "agent.activity" => AgentChange::Activity(decode(payload)),
        "agent.usage" => AgentChange::Usage(decode(payload)),
        "agent.compacted" => AgentChange::Compacted(decode(payload)),
        "agent.exited" => AgentChange::Exited(decode(payload)),
        "agent.closing" => AgentChange::Closing,
        "agent.closed" => AgentChange::Closed,
        other => panic!("no agent event {other}"),
    }
}

/// The change a `mailbox.*` event of `kind` makes.
fn mail_change(kind: &str, payload: &str) -> MailChange {
    match kind {
        "mailbox.queued" => MailChange::Queued(decode(payload)),
        "mailbox.offered" => MailChange::Offered(decode(payload)),
        "mailbox.emitted" => MailChange::Emitted,
        "mailbox.seen" => MailChange::Seen(decode(payload)),
        "mailbox.delivered" => MailChange::Delivered,
        "mailbox.accepted" => MailChange::Accepted(decode(payload)),
        "mailbox.undeliverable" => MailChange::Undeliverable(decode(payload)),
        "mailbox.requeued" => MailChange::Requeued(decode(payload)),
        other => panic!("no mailbox event {other}"),
    }
}

/// The event a recorded step appends.
fn event(step: &Step) -> NewEvent {
    let entity = format!("{:?}", step.entity_id);
    let payload = step.payload.get();
    let actor = step.actor.clone();
    match step.kind.split_once('.').map_or("", |(family, _)| family) {
        "environment" => NewEvent::EnvironmentRegistered {
            environment: decode(&entity),
            payload: decode(payload),
        },
        "agent" => NewEvent::Agent {
            agent: decode(&entity),
            actor,
            change: change(&step.kind, payload),
        },
        "mailbox" => NewEvent::Mail {
            message: decode(&entity),
            actor,
            change: mail_change(&step.kind, payload),
        },
        "message" => NewEvent::MessageObserved {
            observed: decode(&entity),
            actor,
            payload: decode(payload),
        },
        "attention" => NewEvent::Attention {
            attention: decode(&entity),
            actor,
            change: match step.kind.as_str() {
                "attention.opened" => AttentionChange::Opened(decode(payload)),
                "attention.answered" => AttentionChange::Answered(decode(payload)),
                _ => AttentionChange::Closed(decode(payload)),
            },
        },
        "task" if step.kind == "task.created" => NewEvent::TaskCreated {
            task: decode(&entity),
            actor,
            payload: decode(payload),
        },
        "task" => NewEvent::Task {
            task: decode(&entity),
            actor,
            change: match step.kind.as_str() {
                "task.finished" => TaskChange::Finished(decode(payload)),
                "task.owner_changed" => TaskChange::OwnerChanged(decode(payload)),
                _ => TaskChange::Noted(decode(payload)),
            },
        },
        "assignment" => NewEvent::Assignment {
            assignment: decode(&entity),
            actor,
            change: match step.kind.as_str() {
                "assignment.granted" => AssignmentChange::Granted(decode(payload)),
                _ => AssignmentChange::Ended(decode(payload)),
            },
        },
        "terminal" => NewEvent::Terminal {
            terminal: decode(&entity),
            actor: match actor.as_str() {
                "user" => Actor::User,
                "system" => Actor::System,
                other => panic!("no terminal actor {other}"),
            },
            change: match step.kind.as_str() {
                "terminal.needs_restart" => TerminalChange::NeedsRestart(decode(payload)),
                _ => panic!("no event {}", step.kind),
            },
        },
        _ => panic!("no event {}", step.kind),
    }
}

/// A store whose host is the fixture's, so the rows it writes name the same one.
fn store_of_host(dir: &TempDir, host: &str) -> Store {
    let path = dir.db("bazhen.db");
    drop(Store::open(&path).unwrap());
    let db = Connection::open(&path).unwrap();
    db.execute("UPDATE host SET id = ?", [host]).unwrap();
    drop(db);
    Store::open(&path).unwrap()
}

/// A table's rows in the order they were inserted, each column by name, an event's `ts` left out
/// as the fixture leaves it out.
fn rows(store: &Store, table: &str) -> Vec<Value> {
    let mut statement = store
        .db
        .prepare(&format!("SELECT * FROM {table} ORDER BY rowid"))
        .unwrap();
    let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
    statement
        .query_map((), |row| {
            let mut columns = Map::new();
            for (i, name) in names.iter().enumerate() {
                if name == "ts" {
                    continue;
                }
                let value = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => n.into(),
                    ValueRef::Real(x) => x.into(),
                    ValueRef::Text(t) => String::from_utf8_lossy(t).into_owned().into(),
                    ValueRef::Blob(_) => panic!("{table}.{name} is a blob"),
                };
                columns.insert(name.clone(), value);
            }
            Ok(Value::Object(columns))
        })
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

/// Appends each of the fixture's steps, and says of each how it went otherwise than in TypeScript.
fn replay(fixture: &Fixture, store: &mut Store) -> Vec<String> {
    let mut wrong = Vec::new();
    for (i, step) in fixture.steps.iter().enumerate() {
        let event = event(step);
        // The items the event causes were TypeScript's inbox's, which the fixture's store didn't run.
        let got = store.write(|w| w.record(&event));
        // TypeScript records a refusal as its Error's text.
        let refused = step
            .refused
            .as_deref()
            .map(|r| r.strip_prefix("Error: ").unwrap_or(r));
        match (&got, refused) {
            (Ok(_), None) => {}
            (Err(AppendError::Refused { reason, .. }), Some(want)) if reason == want => {}
            // A constraint of the schema both stores share refuses it in each, with SQLite's text.
            (Err(AppendError::Sqlite(err)), Some(want)) if err.to_string() == want => {}
            (Ok(_), Some(want)) => wrong.push(format!(
                "step {i} {}: taken, where TypeScript refused it: {want}",
                step.kind
            )),
            (Err(err), want) => wrong.push(format!(
                "step {i} {}: {err:?}, where TypeScript {}",
                step.kind,
                want.map_or_else(|| "took it".to_owned(), |w| format!("refused it: {w}"))
            )),
        }
    }
    wrong
}

#[test]
fn appends_and_refuses_each_event_as_the_typescript_store_did_and_leaves_its_rows() {
    let fixture = fixture();
    let dir = TempDir::new("agent-events");
    let mut store = store_of_host(&dir, &fixture.host);
    let wrong = replay(&fixture, &mut store);
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
    for (table, want) in &fixture.tables {
        let got = rows(&store, table);
        let want = want.as_array().unwrap();
        assert_eq!(got.len(), want.len(), "the rows of {table}");
        for (i, (got, want)) in got.iter().zip(want).enumerate() {
            assert_eq!(got, want, "{table} row {i}");
        }
    }
}

#[test]
fn snapshots_agents_and_their_items_as_the_typescript_store_did_under_the_same_view() {
    let fixture = fixture();
    let want: Snapshotted = read("snapshot.json");
    let dir = TempDir::new("agent-snapshot");
    let mut store = store_of_host(&dir, &fixture.host);
    assert_eq!(replay(&fixture, &mut store), Vec::<String>::new());
    store
        .db
        .execute("UPDATE events SET ts = ?", [&want.ts])
        .unwrap();
    let view = SnapshotView {
        host: "fixture-host".to_owned(),
        restart_holders: std::collections::HashMap::new(),
        shells_report: true,
    };
    let mut got = store
        .reads()
        .snapshot_with_agents(&view, &FixtureView, Some(&FixtureView))
        .unwrap();
    got.epoch = want.epoch;
    let got = serde_json::to_value(got).unwrap();
    for section in ["agents", "attention"] {
        let (got, want) = (&got[section], &want.snapshot[section]);
        let rows = want.as_array().unwrap();
        assert_eq!(got.as_array().unwrap().len(), rows.len(), "the {section}");
        for (i, (got, want)) in got.as_array().unwrap().iter().zip(rows).enumerate() {
            assert_eq!(got, want, "{section} {i}");
        }
    }
    assert_eq!(got, want.snapshot);
}

#[test]
fn still_refuses_a_snapshot_of_agents_to_a_daemon_that_can_t_describe_them() {
    let fixture = fixture();
    let dir = TempDir::new("agent-snapshot-needs-view");
    let mut store = store_of_host(&dir, &fixture.host);
    replay(&fixture, &mut store);
    let refused = store.reads().snapshot(&crate::testing::view());
    assert!(
        matches!(&refused, Err(crate::SnapshotError::NeedsView(s)) if s == &["agents", "attention"]),
        "{refused:?}"
    );
}

#[test]
fn describes_the_agents_but_still_refuses_their_items_to_a_daemon_that_can_t_describe_those() {
    let fixture = fixture();
    let dir = TempDir::new("agent-snapshot-needs-attention");
    let mut store = store_of_host(&dir, &fixture.host);
    replay(&fixture, &mut store);
    let refused = store
        .reads()
        .snapshot_with_agents(&crate::testing::view(), &FixtureView, None);
    assert!(
        matches!(&refused, Err(crate::SnapshotError::NeedsView(s)) if s == &["attention"]),
        "{refused:?}"
    );
}

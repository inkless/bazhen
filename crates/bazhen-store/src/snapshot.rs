//! `/v1/state`: every read model a client draws, with the cursor its event stream resumes from,
//! read in one transaction so the two agree.

use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::notices::Notice;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::events::Reads;

/// A section of the snapshot this build can't describe yet. Each needs what the daemon knows of
/// runtimes and harnesses (how to attach, which themes, what can be resumed, what the human can do
/// now); a database the TypeScript daemon used may hold its rows, and a snapshot that left them out
/// or guessed would be wrong rather than incomplete.
struct Unported {
    section: &'static str,
    rows: &'static str,
}

const UNPORTED: [Unported; 2] = [
    // Lifted by the slice that brings agents, their mail and the human's inbox.
    Unported {
        section: "agents",
        rows: "SELECT 1 FROM agent_sessions",
    },
    Unported {
        section: "attention",
        rows: "SELECT 1 FROM attention_items",
    },
];

/// How many observed messages a snapshot carries: the latest.
const OBSERVED_KEPT: u32 = 200;

/// How many closed notices a snapshot carries, the latest closed, besides every open one.
const CLOSED_NOTICES_SHOWN: u32 = 20;

/// What the owner on this machine can do about an open notice; a device's viewer can do nothing,
/// and the daemon takes it out of what such a viewer is sent.
const OPEN_NOTICE_ACTIONS: [&str; 1] = ["dismiss"];

/// What the snapshot needs of the daemon, which the database doesn't hold.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SnapshotView {
    /// This machine's name, which each local environment is on.
    pub host: String,
}

#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    /// The database holds rows of sections this build can't describe yet.
    #[error("this daemon can't describe {} yet", .0.join(", "))]
    Unported(Vec<&'static str>),
    #[error("a stored row doesn't read as the protocol's: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

impl Reads<'_> {
    /// The snapshot, and the cursor after its newest event.
    ///
    /// # Errors
    ///
    /// [`SnapshotError::Unported`] when the database holds what this build can't describe.
    pub fn snapshot(self, view: &SnapshotView) -> Result<StateSnapshot, SnapshotError> {
        let tx = self.0.unchecked_transaction()?;
        let reads = Reads(&tx);
        let mut unported = Vec::new();
        for section in &UNPORTED {
            if tx.prepare(section.rows)?.exists(())? {
                unported.push(section.section);
            }
        }
        if !unported.is_empty() {
            return Err(SnapshotError::Unported(unported));
        }
        let snapshot = StateSnapshot {
            epoch: reads.epoch()?,
            event_id: reads.latest_event_id()?,
            environments: crate::terminals::environments(&tx, &view.host)?,
            agents: Vec::new(),
            attention: Vec::new(),
            messages: rows(
                &tx,
                "SELECT id, agent_session_id AS agentId, state FROM mailbox ORDER BY created_event_id",
                (),
            )?,
            shells: crate::terminals::shells(&tx)?,
            tasks: rows(
                &tx,
                "SELECT id, title, state, owner_agent_id AS ownerAgentId,
                   parent_task_id AS parentTaskId FROM tasks ORDER BY created_event_id",
                (),
            )?,
            assignments: rows(
                &tx,
                "SELECT id, task_id AS taskId, agent_session_id AS agentId, role,
                   parent_assignment_id AS parentAssignmentId, state, end_reason AS endReason
                 FROM assignments ORDER BY created_event_id",
                (),
            )?,
            notices: notices(&tx)?,
            observed: rows(
                &tx,
                "SELECT id, \"from\", \"to\", summary, accepted = 1 AS accepted, at FROM (
                   SELECT o.id, o.from_agent_id AS \"from\", o.to_agent_id AS \"to\", o.summary,
                          o.accepted, e.ts AS at, o.created_event_id
                   FROM observed_messages o JOIN events e ON e.id = o.created_event_id
                   ORDER BY o.created_event_id DESC LIMIT ?
                 ) ORDER BY created_event_id",
                [OBSERVED_KEPT],
            )?,
        };
        tx.finish()?;
        Ok(snapshot)
    }
}

/// Every open notice, and the latest closed ones, oldest first, as the owner on this machine sees
/// them.
fn notices(db: &rusqlite::Connection) -> Result<Vec<Notice>, SnapshotError> {
    let mut statement = db.prepare(
        "SELECT n.id, n.kind, n.state, n.close_reason, n.summary, e.ts, n.device_id, n.device_name,
           n.device_origin, n.device_address, n.closed_by, n.closed_from_device, d.name
         FROM notices n JOIN events e ON e.id = n.created_event_id
         LEFT JOIN devices d ON d.id = n.closed_from_device
         WHERE n.state = 'open' OR n.id IN (
           SELECT id FROM notices WHERE state = 'closed' ORDER BY updated_event_id DESC LIMIT ?)
         ORDER BY n.created_event_id",
    )?;
    let rows = statement
        .query_map([CLOSED_NOTICES_SHOWN], |row| {
            let device = match row.get::<_, Option<String>>(6)? {
                Some(id) => Some(serde_json::json!({
                    "id": id,
                    "name": row.get::<_, String>(7)?,
                    "origin": row.get::<_, String>(8)?,
                    "address": row.get::<_, Option<String>>(9)?,
                })),
                None => None,
            };
            let closed_from = match row.get::<_, Option<String>>(11)? {
                Some(id) => {
                    Some(serde_json::json!({ "id": id, "name": row.get::<_, String>(12)? }))
                }
                None => None,
            };
            let state: String = row.get(2)?;
            let actions: &[&str] = if state == "open" {
                &OPEN_NOTICE_ACTIONS
            } else {
                &[]
            };
            Ok(serde_json::json!({
                "id": row.get::<_, String>(0)?,
                "kind": row.get::<_, String>(1)?,
                "state": state,
                "closeReason": row.get::<_, Option<String>>(3)?,
                "summary": row.get::<_, String>(4)?,
                "openedAt": row.get::<_, String>(5)?,
                "device": device,
                "actions": actions,
                "closedBy": row.get::<_, Option<String>>(10)?,
                "closedFrom": closed_from,
            }))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<_, _>>()?)
}

/// Each row `sql` reads, as the protocol type its columns name; a column read as `accepted`, a
/// comparison, is a boolean.
fn rows<T: DeserializeOwned>(
    db: &rusqlite::Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<T>, SnapshotError> {
    let mut statement = db.prepare(sql)?;
    let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
    let objects = statement
        .query_map(params, |row| {
            let mut object = Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get_ref(i)? {
                    rusqlite::types::ValueRef::Integer(n) if name == "accepted" => (n == 1).into(),
                    rusqlite::types::ValueRef::Integer(n) => n.into(),
                    rusqlite::types::ValueRef::Text(t) => {
                        String::from_utf8_lossy(t).into_owned().into()
                    }
                    rusqlite::types::ValueRef::Real(r) => r.into(),
                    rusqlite::types::ValueRef::Null | rusqlite::types::ValueRef::Blob(_) => {
                        Value::Null
                    }
                };
                object.insert(name.clone(), value);
            }
            Ok(Value::Object(object))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(objects
        .into_iter()
        .map(serde_json::from_value)
        .collect::<Result<_, _>>()?)
}

//! `/v1/state`: every read model a client draws, with the cursor its event stream resumes from,
//! read in one transaction so the two agree.

use bazhen_protocol::agents::StateSnapshot;
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

const UNPORTED: [Unported; 5] = [
    // Lifted by the slice that brings environments, terminals and shells.
    Unported {
        section: "environments",
        rows: "SELECT 1 FROM environments",
    },
    Unported {
        section: "shells",
        rows: "SELECT 1 FROM terminals WHERE kind = 'shell' AND state NOT IN ('closed', 'failed')",
    },
    // Lifted by the slice that brings agents, their mail and the human's inbox.
    Unported {
        section: "agents",
        rows: "SELECT 1 FROM agent_sessions",
    },
    Unported {
        section: "attention",
        rows: "SELECT 1 FROM attention_items",
    },
    // Lifted by the slice that brings pairing and devices.
    Unported {
        section: "notices",
        rows: "SELECT 1 FROM notices",
    },
];

/// How many observed messages a snapshot carries: the latest.
const OBSERVED_KEPT: u32 = 200;

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
    pub fn snapshot(self) -> Result<StateSnapshot, SnapshotError> {
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
            environments: Vec::new(),
            agents: Vec::new(),
            attention: Vec::new(),
            messages: rows(
                &tx,
                "SELECT id, agent_session_id AS agentId, state FROM mailbox ORDER BY created_event_id",
                (),
            )?,
            shells: Vec::new(),
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
            notices: Vec::new(),
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

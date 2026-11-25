//! `/v1/state`: every read model a client draws, with the cursor its event stream resumes from,
//! read in one transaction so the two agree.

use std::collections::HashMap;

use bazhen_protocol::agents::StateSnapshot;
use bazhen_protocol::notices::Notice;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value};

use crate::agent_snapshot::{AgentView, AttentionView};
use crate::events::Reads;

/// A section of the snapshot a daemon can describe only with a view of its own: each needs what
/// it knows of harnesses (which themes, what can be resumed, what the human can do now). A
/// database the TypeScript daemon used may hold its rows, and a snapshot that left them out or
/// guessed would be wrong rather than incomplete.
struct ViewedSection {
    section: &'static str,
    rows: &'static str,
}

/// The agents, which an [`AgentView`] describes.
const AGENTS: ViewedSection = ViewedSection {
    section: "agents",
    rows: "SELECT 1 FROM agent_sessions",
};

/// The items for the human, which an [`AttentionView`] describes.
const ATTENTION: ViewedSection = ViewedSection {
    section: "attention",
    rows: "SELECT 1 FROM attention_items",
};

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
    /// The holder to end for each terminal that needs a restart, by its id, as last proved still
    /// running there: a pid that wasn't is never named.
    pub restart_holders: HashMap<String, u64>,
    /// Whether this daemon's shells report the lines they run, so a lost shell's kept line can
    /// be typed back.
    pub shells_report: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum SnapshotError {
    /// The database holds rows of sections only a view describes, and the snapshot was taken
    /// without it.
    #[error("this daemon can't describe {} yet", .0.join(", "))]
    NeedsView(Vec<&'static str>),
    #[error("a stored row doesn't read as the protocol's: {0}")]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

impl Reads<'_> {
    /// The snapshot, and the cursor after its newest event, for a daemon that can't describe
    /// agents or their items.
    ///
    /// # Errors
    ///
    /// [`SnapshotError::NeedsView`] when the database holds agents or items for the human.
    pub fn snapshot(self, view: &SnapshotView) -> Result<StateSnapshot, SnapshotError> {
        self.read(view, None, None)
    }

    /// The snapshot, and the cursor after its newest event, its agents described as `agents`
    /// says, and its items for the human as `attention` does.
    ///
    /// # Errors
    ///
    /// [`SnapshotError::NeedsView`] when the database holds items for the human and `attention`
    /// is none; a stored row that doesn't read as the protocol's.
    pub fn snapshot_with_agents(
        self,
        view: &SnapshotView,
        agents: &dyn AgentView,
        attention: Option<&dyn AttentionView>,
    ) -> Result<StateSnapshot, SnapshotError> {
        self.read(view, Some(agents), attention)
    }

    fn read(
        self,
        view: &SnapshotView,
        agents: Option<&dyn AgentView>,
        attention: Option<&dyn AttentionView>,
    ) -> Result<StateSnapshot, SnapshotError> {
        let tx = self.0.unchecked_transaction()?;
        let reads = Reads(&tx);
        let mut needed = Vec::new();
        for (section, given) in [(AGENTS, agents.is_some()), (ATTENTION, attention.is_some())] {
            if !given && tx.prepare(section.rows)?.exists(())? {
                needed.push(section.section);
            }
        }
        if !needed.is_empty() {
            return Err(SnapshotError::NeedsView(needed));
        }
        let snapshot = StateSnapshot {
            epoch: reads.epoch()?,
            event_id: reads.latest_event_id()?,
            environments: crate::terminals::environments(&tx, &view.host)?,
            agents: match agents {
                Some(agents) => crate::agent_snapshot::agents(&tx, view, agents)?,
                None => Vec::new(),
            },
            attention: match attention {
                Some(attention) => crate::agent_snapshot::attention(&tx, attention)?,
                None => Vec::new(),
            },
            messages: rows(
                &tx,
                "SELECT id, agent_session_id AS agentId, state FROM mailbox ORDER BY created_event_id",
                (),
            )?,
            shells: crate::terminals::shells(&tx, view)?,
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

/// The columns read as booleans: `accepted`, a comparison, and a note's `handoff`, which `SQLite`
/// keeps as 0 or 1.
const BOOLEAN_COLUMNS: [&str; 2] = ["accepted", "handoff"];

/// Each row `sql` reads, as the protocol type its columns name; a column of `BOOLEAN_COLUMNS` is a
/// boolean.
fn rows<T: DeserializeOwned>(
    db: &rusqlite::Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<T>, SnapshotError> {
    read_rows(db, sql, params)
}

/// [`rows`], for a read with an error of its own.
pub(crate) fn read_rows<T: DeserializeOwned, E: From<rusqlite::Error> + From<serde_json::Error>>(
    db: &rusqlite::Connection,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<Vec<T>, E> {
    let mut statement = db.prepare(sql)?;
    let names: Vec<String> = statement.column_names().map(str::to_owned).collect();
    let objects = statement
        .query_map(params, |row| {
            let mut object = Map::new();
            for (i, name) in names.iter().enumerate() {
                let value = match row.get_ref(i)? {
                    rusqlite::types::ValueRef::Integer(n)
                        if BOOLEAN_COLUMNS.contains(&name.as_str()) =>
                    {
                        (n == 1).into()
                    }
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

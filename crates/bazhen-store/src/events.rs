//! The event log: every change is an event appended with its projection in one transaction, read
//! back in id order from a cursor, and retired once old unless a projection still points at it.

use std::num::NonZeroU32;

use bazhen_protocol::events::{ResetReason, TaskCreated, event_kind};
use bazhen_protocol::ids::TaskId;
use bazhen_protocol::record::Record;
use rusqlite::{Connection, OptionalExtension, Transaction};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::value::RawValue;

use crate::projections;

/// An event this build records, with the entity it is about and who it came from: an agent's id,
/// or a word naming the human or the system.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum NewEvent {
    TaskCreated {
        task: TaskId,
        actor: String,
        payload: TaskCreated,
    },
}

impl NewEvent {
    pub(crate) fn name(&self) -> &'static str {
        match self {
            Self::TaskCreated { .. } => "task.created",
        }
    }

    fn entity_id(&self) -> &str {
        match self {
            Self::TaskCreated { task, .. } => task.as_str(),
        }
    }

    fn actor(&self) -> &str {
        match self {
            Self::TaskCreated { actor, .. } => actor,
        }
    }

    fn payload(&self) -> serde_json::Result<String> {
        match self {
            Self::TaskCreated { payload, .. } => serde_json::to_string(payload),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum AppendError {
    /// The schema has no host yet, so no event can be stamped with one.
    #[error("the database has no host to stamp events with")]
    NoHost,
    /// The projection refused the event, and nothing of it was recorded.
    #[error("{event} refused: {reason}")]
    Refused { event: &'static str, reason: String },
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// A write transaction: what it appends commits or rolls back with what else it wrote.
#[derive(Debug)]
pub struct Writer<'a> {
    pub(crate) tx: Transaction<'a>,
    pub(crate) host: Option<&'a str>,
}

impl Writer<'_> {
    /// Appends `event` and applies it to the read models, answering its id.
    ///
    /// # Errors
    ///
    /// [`AppendError`]. The event's row may already be written: returned out of
    /// [`Store::write`](crate::Store::write), the error rolls the whole transaction back, so a
    /// caller that swallows it instead commits an event without its projection.
    pub fn append(&self, event: &NewEvent) -> Result<u64, AppendError> {
        let host = self.host.ok_or(AppendError::NoHost)?;
        let kind = event_kind(event.name()).ok_or_else(|| AppendError::Refused {
            event: event.name(),
            reason: "the type isn't registered".to_owned(),
        })?;
        self.tx.execute(
            "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, causation_id,
               correlation_id, payload) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?)",
            (
                host,
                crate::now(),
                kind.name,
                kind.entity,
                event.entity_id(),
                event.actor(),
                event.payload()?,
            ),
        )?;
        let id = u64::try_from(self.tx.last_insert_rowid()).map_err(|_| AppendError::Refused {
            event: kind.name,
            reason: "its id isn't positive".to_owned(),
        })?;
        projections::project(&self.tx, id, event)?;
        Ok(id)
    }

    /// The connection, for reading inside the transaction.
    pub fn connection(&self) -> &Connection {
        &self.tx
    }
}

/// An event as stored: its payload is the text it was written as, whichever build wrote it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StoredEvent {
    pub id: u64,
    pub ts: String,
    pub kind: String,
    pub entity_type: String,
    pub entity_id: String,
    pub actor: String,
    pub causation_id: Option<i64>,
    pub correlation_id: Option<String>,
    pub payload: String,
}

/// Why a stored event can't be sent.
#[derive(Debug, thiserror::Error)]
pub enum FrameError {
    #[error("event {id} is of a type no build registered: {kind} about a {entity}")]
    Unregistered {
        id: u64,
        kind: String,
        entity: String,
    },
    #[error("event {id}'s payload isn't a JSON object: {source}")]
    Malformed { id: u64, source: serde_json::Error },
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

#[derive(Serialize)]
struct Frame<'a> {
    #[serde(rename = "type")]
    frame: &'static str,
    event: Envelope<'a>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Envelope<'a> {
    id: u64,
    ts: &'a str,
    #[serde(rename = "type")]
    kind: &'a str,
    entity_type: &'a str,
    entity_id: &'a str,
    actor: &'a str,
    causation_id: Option<i64>,
    correlation_id: Option<&'a str>,
    payload: Record<&'a RawValue>,
}

impl StoredEvent {
    /// The `event` frame the stream sends for it. Its payload keeps only the keys its type
    /// streams, in their order, so what a client mustn't see never leaves, whatever the values
    /// hold. Unlike the TypeScript daemon, which parses each value with its schema, a value is
    /// sent as stored: only a row no daemon would have written differs, one whose value has
    /// another type, which TypeScript fails the stream on, a payload missing a key its type
    /// streams, as `{"brief":"x"}` for `task.created`, which TypeScript fails the stream on and
    /// this sends as `{}`, or a title stored untrimmed, which it sends trimmed.
    ///
    /// # Errors
    ///
    /// [`FrameError`]: a type no build registered, or a payload that isn't an object.
    pub fn frame(&self) -> Result<String, FrameError> {
        let unregistered = || FrameError::Unregistered {
            id: self.id,
            kind: self.kind.clone(),
            entity: self.entity_type.clone(),
        };
        let kind = event_kind(&self.kind).ok_or_else(unregistered)?;
        if kind.entity != self.entity_type {
            return Err(unregistered());
        }
        let stored: Record<&RawValue> =
            serde_json::from_str(&self.payload).map_err(|source| FrameError::Malformed {
                id: self.id,
                source,
            })?;
        let payload = kind
            .streamed
            .iter()
            .filter_map(|key| {
                let (_, value) = stored.entries().iter().find(|(k, _)| k == key)?;
                Some(((*key).to_owned(), *value))
            })
            .collect();
        Ok(serde_json::to_string(&Frame {
            frame: "event",
            event: Envelope {
                id: self.id,
                ts: &self.ts,
                kind: &self.kind,
                entity_type: &self.entity_type,
                entity_id: &self.entity_id,
                actor: &self.actor,
                causation_id: self.causation_id,
                correlation_id: self.correlation_id.as_deref(),
                payload: Record::new(payload),
            },
        })?)
    }
}

/// What a stream sends next from a cursor.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Page {
    /// The cursor can't resume here: the client must start again from a snapshot.
    Reset(ResetReason),
    /// The events after the cursor, oldest first; none when it is at the newest.
    Events(Vec<StoredEvent>),
}

/// Reads of the log, on any connection to it.
#[derive(Debug, Clone, Copy)]
pub struct Reads<'a>(pub(crate) &'a Connection);

impl Reads<'_> {
    /// The epoch every cursor into this database carries.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn epoch(self) -> rusqlite::Result<String> {
        self.0
            .query_row("SELECT epoch FROM event_log", (), |row| row.get(0))
    }

    /// The id of the newest event, or 0 for an empty log.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn latest_event_id(self) -> rusqlite::Result<u64> {
        self.0
            .query_row("SELECT coalesce(max(id), 0) FROM events", (), |row| {
                unsigned(row, 0)
            })
    }

    /// Up to `limit` events after `after`, oldest first.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn events(self, after: u64, limit: u32) -> rusqlite::Result<Vec<StoredEvent>> {
        self.0
            .prepare(
                "SELECT id, ts, type, entity_type, entity_id, actor, causation_id, correlation_id,
                   payload FROM events WHERE id > ? ORDER BY id LIMIT ?",
            )?
            .query_map((int(after)?, limit), |row| {
                Ok(StoredEvent {
                    id: unsigned(row, 0)?,
                    ts: row.get(1)?,
                    kind: row.get(2)?,
                    entity_type: row.get(3)?,
                    entity_id: row.get(4)?,
                    actor: row.get(5)?,
                    causation_id: row.get(6)?,
                    correlation_id: row.get(7)?,
                    payload: row.get(8)?,
                })
            })?
            .collect()
    }

    /// The page a stream sends after `after` in `epoch`: up to `limit` events, unless the cursor
    /// can't resume. Read in one transaction, so retention can't retire what the page should
    /// hold between the check and the read.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn page(self, epoch: &str, after: u64, limit: u32) -> rusqlite::Result<Page> {
        let tx = self.0.unchecked_transaction()?;
        let reads = Reads(&tx);
        let page = match reads.cursor_fault(epoch, after)? {
            Some(reason) => Page::Reset(reason),
            None => Page::Events(reads.events(after, limit)?),
        };
        tx.finish()?;
        Ok(page)
    }

    /// Why a stream can't resume after `after` in `epoch`, if it can't: the cursor names another
    /// database or an event this one never had, or retention has passed it.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn cursor_fault(self, epoch: &str, after: u64) -> rusqlite::Result<Option<ResetReason>> {
        let (ours, pruned, newest): (String, u64, u64) = self.0.query_row(
            "SELECT epoch, pruned_through, (SELECT coalesce(max(id), 0) FROM events) FROM event_log",
            (),
            |row| Ok((row.get(0)?, unsigned(row, 1)?, unsigned(row, 2)?)),
        )?;
        Ok(if epoch != ours || after > newest {
            Some(ResetReason::Foreign)
        } else if after < pruned {
            Some(ResetReason::Stale)
        } else {
            None
        })
    }
}

/// Why a mutation under an idempotency key wasn't run or replayed.
#[derive(Debug, thiserror::Error)]
pub enum OnceError {
    /// The key was first used for another request.
    #[error("idempotency key {0:?} was already used for another request")]
    Conflict(String),
    #[error("the answer kept for idempotency key {key:?} can't be read: {source}")]
    Unreadable {
        key: String,
        source: serde_json::Error,
    },
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

#[derive(Serialize)]
struct Answer<'a, R> {
    request: &'a str,
    response: &'a R,
}

#[derive(serde::Deserialize)]
struct Kept {
    #[serde(default)]
    request: Option<serde_json::Value>,
    response: serde_json::Value,
}

/// The answer first given to `key`, if it was given for `request`.
pub(crate) fn replay<R: DeserializeOwned>(
    db: &Connection,
    key: &str,
    request: &str,
) -> Result<Option<R>, OnceError> {
    let kept: Option<String> = db
        .query_row(
            "SELECT response FROM idempotency_keys WHERE key = ?",
            [key],
            |row| row.get(0),
        )
        .optional()?;
    let Some(kept) = kept else { return Ok(None) };
    let unreadable = |source| OnceError::Unreadable {
        key: key.to_owned(),
        source,
    };
    let kept: Kept = serde_json::from_str(&kept).map_err(unreadable)?;
    if kept.request.as_ref().and_then(serde_json::Value::as_str) != Some(request) {
        return Err(OnceError::Conflict(key.to_owned()));
    }
    serde_json::from_value(kept.response)
        .map(Some)
        .map_err(unreadable)
}

/// Records `response` as the answer to `key` for `request`, as the TypeScript daemon records it.
pub(crate) fn answered<R: Serialize>(
    db: &Connection,
    key: &str,
    request: &str,
    response: &R,
) -> Result<(), OnceError> {
    db.execute(
        "INSERT OR REPLACE INTO idempotency_keys (key, response) VALUES (?, ?)",
        (key, serde_json::to_string(&Answer { request, response })?),
    )?;
    Ok(())
}

const QUOTE: char = '"';

fn quoted(name: &str) -> String {
    format!("{QUOTE}{}{QUOTE}", name.replace(QUOTE, "\"\""))
}

/// One query for every event id a projection column points at, read from the schema's foreign
/// keys, so a table added later is kept without retention having to know about it.
pub(crate) fn referenced_events(db: &Connection) -> rusqlite::Result<String> {
    let columns: Vec<(String, String)> = db
        .prepare(
            "SELECT m.name, f.\"from\" FROM sqlite_master m, pragma_foreign_key_list(m.name) f
             WHERE m.type = 'table' AND f.\"table\" = 'events' ORDER BY m.name, f.\"from\"",
        )?
        .query_map((), |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    // NOT IN over a NULL is never true, which would keep every event.
    let selects: Vec<String> = columns
        .iter()
        .map(|(table, column)| {
            let column = quoted(column);
            format!(
                "SELECT {column} FROM {} WHERE {column} IS NOT NULL",
                quoted(table)
            )
        })
        .collect();
    Ok(if selects.is_empty() {
        "SELECT NULL WHERE 0".to_owned()
    } else {
        selects.join(" UNION ")
    })
}

/// Retires up to `limit` events recorded before `cutoff` (an ISO timestamp), walking up from where
/// retention last stopped, and answers whether any may remain. Events a projection points at
/// stay, and so does the newest: ids are max(id) + 1, so deleting it would hand out ids retention
/// has passed. Events kept earlier are looked at again each time, and go once nothing points at
/// them.
pub(crate) fn prune_batch(
    tx: &Transaction<'_>,
    referenced: &str,
    cutoff: &str,
    limit: NonZeroU32,
) -> rusqlite::Result<bool> {
    let from = tx.query_row("SELECT pruned_through FROM event_log", (), |row| {
        unsigned(row, 0)
    })?;
    let rows: Vec<(u64, String)> = tx
        .prepare("SELECT id, ts FROM events WHERE id > ? ORDER BY id LIMIT ?")?
        .query_map((int(from)?, limit.get()), |row| {
            Ok((unsigned(row, 0)?, row.get(1)?))
        })?
        .collect::<rusqlite::Result<_>>()?;
    let young = rows.iter().position(|(_, ts)| ts.as_str() >= cutoff);
    let expired = rows.get(..young.unwrap_or(rows.len())).unwrap_or_default();
    let through = expired.last().map_or(from, |(id, _)| *id);
    tx.execute(
        &format!(
            "DELETE FROM events WHERE id <= ?
               AND id <> (SELECT max(id) FROM events) AND id NOT IN ({referenced})"
        ),
        [int(through)?],
    )?;
    tx.execute("UPDATE event_log SET pruned_through = ?", [int(through)?])?;
    Ok(young.is_none() && rows.len() == usize::try_from(limit.get()).unwrap_or(usize::MAX))
}

/// Column `idx` of `row`, an integer the schema keeps at zero or above.
pub(crate) fn unsigned(row: &rusqlite::Row<'_>, idx: usize) -> rusqlite::Result<u64> {
    let n: i64 = row.get(idx)?;
    u64::try_from(n).map_err(|err| {
        rusqlite::Error::FromSqlConversionFailure(
            idx,
            rusqlite::types::Type::Integer,
            Box::new(err),
        )
    })
}

/// `n` as `SQLite` stores an integer.
pub(crate) fn int(n: u64) -> rusqlite::Result<i64> {
    i64::try_from(n).map_err(|err| rusqlite::Error::ToSqlConversionFailure(Box::new(err)))
}

#[cfg(test)]
mod tests {
    use bazhen_protocol::ids::TaskId;

    use super::*;
    use crate::testing::TempDir;
    use crate::{MIGRATIONS, Store};

    const OLD: &str = "2000-01-01T00:00:00.000Z";
    const CUTOFF: &str = "2020-01-01T00:00:00.000Z";

    fn at(iso: &str) -> jiff::Timestamp {
        iso.parse().unwrap()
    }

    fn task(n: u8) -> TaskId {
        TaskId::mint(1, [n; 16])
    }

    fn created(task: TaskId, parent: Option<TaskId>) -> NewEvent {
        NewEvent::TaskCreated {
            task,
            actor: "human".to_owned(),
            payload: TaskCreated {
                title: "Ship".to_owned(),
                brief: "the brief".to_owned(),
                owner_agent_id: None,
                parent_task_id: parent,
                delegated_from: None,
            },
        }
    }

    fn append(store: &mut Store, event: &NewEvent) -> u64 {
        store.write(|w| w.append(event)).unwrap()
    }

    /// An event of a type this build doesn't append, which no projection points at.
    fn visit(store: &Store) -> u64 {
        store
            .db
            .execute(
                "INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
                 VALUES ((SELECT id FROM host), ?, 'attachment.ended', 'attachment', 'att_1',
                   'system', '{\"reason\":\"client_closed\"}')",
                [crate::now()],
            )
            .unwrap();
        u64::try_from(store.db.last_insert_rowid()).unwrap()
    }

    fn age(store: &Store) {
        store.db.execute("UPDATE events SET ts = ?", [OLD]).unwrap();
    }

    fn ids(store: &Store) -> Vec<u64> {
        store
            .reads()
            .events(0, 500)
            .unwrap()
            .iter()
            .map(|e| e.id)
            .collect()
    }

    fn stored(kind: &str, entity: &str, payload: &str) -> StoredEvent {
        StoredEvent {
            id: 7,
            ts: "2026-11-01T00:00:00.000Z".to_owned(),
            kind: kind.to_owned(),
            entity_type: entity.to_owned(),
            entity_id: "task_1".to_owned(),
            actor: "human".to_owned(),
            causation_id: None,
            correlation_id: None,
            payload: payload.to_owned(),
        }
    }

    fn streamed_payload(event: &StoredEvent) -> String {
        let frame = event.frame().unwrap();
        let (_, payload) = frame.split_once(r#""payload":"#).unwrap();
        payload.strip_suffix("}}").unwrap().to_owned()
    }

    #[test]
    fn gives_each_database_its_own_epoch_kept_across_reopen() {
        let dir = TempDir::new("epoch");
        let first = Store::open(&dir.db("a.db")).unwrap();
        let epoch = first.reads().epoch().unwrap();
        drop(first);
        let again = Store::open(&dir.db("a.db")).unwrap();
        let other = Store::open(&dir.db("b.db")).unwrap();
        assert!(
            epoch.len() == 32 && epoch.bytes().all(|b| b.is_ascii_hexdigit()),
            "{epoch}"
        );
        assert_eq!(again.reads().epoch().unwrap(), epoch);
        assert_ne!(other.reads().epoch().unwrap(), epoch);
    }

    #[test]
    fn mints_an_epoch_for_a_database_upgraded_from_schema_5_resumable_from_its_newest_event() {
        let dir = TempDir::new("epoch-upgrade");
        let path = dir.db("bazhen.db");
        let v5 = Store::open_with(&path, MIGRATIONS.get(..5).unwrap()).unwrap();
        let newest = visit(&v5);
        drop(v5);
        let upgraded = Store::open(&path).unwrap();
        let epoch = upgraded.reads().epoch().unwrap();
        assert_eq!(upgraded.reads().latest_event_id().unwrap(), newest);
        assert_eq!(upgraded.reads().cursor_fault(&epoch, newest).unwrap(), None);
    }

    #[test]
    fn reads_back_each_event_whole_payload_included() {
        let dir = TempDir::new("read-back");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let id = append(&mut store, &created(task(1), None));
        let events = store.reads().events(0, 500).unwrap();
        let [event] = events.as_slice() else {
            panic!("{events:?}")
        };
        assert_eq!(
            (
                event.id,
                event.kind.as_str(),
                event.entity_type.as_str(),
                event.entity_id.as_str()
            ),
            (id, "task.created", "task", task(1).as_str())
        );
        assert_eq!(
            (
                event.actor.as_str(),
                event.causation_id,
                event.correlation_id.as_deref()
            ),
            ("human", None, None)
        );
        assert_eq!(
            event.payload,
            r#"{"title":"Ship","brief":"the brief","ownerAgentId":null,"parentTaskId":null,"delegatedFrom":null}"#
        );
        assert_eq!(store.host_id().map(|h| h.as_str().to_owned()), {
            let host: String = store
                .db
                .query_row("SELECT host_id FROM events", (), |r| r.get(0))
                .unwrap();
            Some(host)
        });
    }

    #[test]
    fn pages_events_after_a_cursor_in_id_order() {
        let dir = TempDir::new("pages");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        for n in 1..=5 {
            append(&mut store, &created(task(n), None));
        }
        let page: Vec<u64> = store
            .reads()
            .events(2, 2)
            .unwrap()
            .iter()
            .map(|e| e.id)
            .collect();
        assert_eq!(page, [3, 4]);
        assert_eq!(store.reads().latest_event_id().unwrap(), 5);
    }

    #[test]
    fn records_no_event_when_its_projection_refuses_it() {
        let dir = TempDir::new("refused");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let orphan = created(task(2), Some(task(9)));
        assert!(matches!(
            store.write(|w| w.append(&orphan)),
            Err(AppendError::Sqlite(_))
        ));
        assert_eq!(store.reads().latest_event_id().unwrap(), 0);
    }

    #[test]
    fn keeps_nothing_a_write_appended_when_it_then_fails() {
        let dir = TempDir::new("rolled-back");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let failed: Result<(), AppendError> = store.write(|w| {
            w.append(&created(task(1), None))?;
            Err(AppendError::NoHost)
        });
        assert!(failed.is_err());
        let tasks: i64 = store
            .db
            .query_row("SELECT count(*) FROM tasks", (), |r| r.get(0))
            .unwrap();
        assert_eq!((store.reads().latest_event_id().unwrap(), tasks), (0, 0));
    }

    #[test]
    fn calls_a_cursor_foreign_when_it_names_another_store_or_an_event_this_one_never_had() {
        let dir = TempDir::new("foreign");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let newest = append(&mut store, &created(task(1), None));
        let reads = store.reads();
        let epoch = reads.epoch().unwrap();
        let faults = [
            reads.cursor_fault(&"0".repeat(32), newest).unwrap(),
            reads.cursor_fault(&epoch, newest + 1).unwrap(),
            reads.cursor_fault(&epoch, newest).unwrap(),
            reads.cursor_fault(&epoch, 0).unwrap(),
        ];
        assert_eq!(
            faults,
            [
                Some(ResetReason::Foreign),
                Some(ResetReason::Foreign),
                None,
                None
            ]
        );
    }

    #[test]
    fn retires_old_events_no_projection_points_at_and_keeps_those_one_does() {
        let dir = TempDir::new("retire");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let kept = append(&mut store, &created(task(1), None));
        visit(&store);
        let ended = visit(&store);
        age(&store);
        let young = visit(&store);
        assert!(
            !store
                .prune_batch(at(CUTOFF), NonZeroU32::new(1000).unwrap())
                .unwrap()
        );
        assert_eq!(ids(&store), [kept, young]);
        let epoch = store.reads().epoch().unwrap();
        let reads = store.reads();
        assert_eq!(
            [
                reads.cursor_fault(&epoch, ended - 1).unwrap(),
                reads.cursor_fault(&epoch, ended).unwrap()
            ],
            [Some(ResetReason::Stale), None]
        );
    }

    #[test]
    fn retires_an_event_recorded_before_the_cutoff_and_keeps_one_recorded_at_it() {
        let dir = TempDir::new("cutoff");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let ids = [visit(&store), visit(&store), visit(&store)];
        let times = [
            "2019-12-31T23:59:59.999Z",
            CUTOFF,
            "2000-01-01T00:00:00.000Z",
        ];
        for (id, ts) in ids.iter().zip(times) {
            store
                .db
                .execute(
                    "UPDATE events SET ts = ? WHERE id = ?",
                    (ts, int(*id).unwrap()),
                )
                .unwrap();
        }
        store
            .prune_batch(at(CUTOFF), NonZeroU32::new(1000).unwrap())
            .unwrap();
        assert_eq!(super::tests::ids(&store), [ids[1], ids[2]]);
    }

    #[test]
    fn pages_from_a_cursor_or_says_why_it_cant_in_one_read() {
        let dir = TempDir::new("page");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let first = visit(&store);
        let second = visit(&store);
        let newest = append(&mut store, &created(task(1), None));
        let epoch = store.reads().epoch().unwrap();
        let page = |after| match store.reads().page(&epoch, after, 1).unwrap() {
            Page::Events(events) => Ok(events.iter().map(|e| e.id).collect::<Vec<_>>()),
            Page::Reset(reason) => Err(reason),
        };
        assert_eq!(
            [page(0), page(second), page(newest), page(newest + 1)],
            [
                Ok(vec![first]),
                Ok(vec![newest]),
                Ok(vec![]),
                Err(ResetReason::Foreign)
            ]
        );
    }

    #[test]
    fn refuses_a_task_whose_title_or_brief_the_typescript_projection_would_refuse() {
        let dir = TempDir::new("refused-title");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let with = |title: &str, brief: &str| {
            let NewEvent::TaskCreated {
                task,
                actor,
                mut payload,
            } = created(task(1), None);
            payload.title = title.to_owned();
            payload.brief = brief.to_owned();
            NewEvent::TaskCreated {
                task,
                actor,
                payload,
            }
        };
        for event in [with(" Ship", "b"), with("", "b"), with("Ship", "")] {
            let refused = store.write(|w| w.append(&event));
            assert!(
                matches!(refused, Err(AppendError::Refused { .. })),
                "{event:?}"
            );
        }
        assert_eq!(store.reads().latest_event_id().unwrap(), 0);
    }

    #[test]
    fn never_retires_the_newest_event_so_later_ids_stay_above_what_retention_passed() {
        let dir = TempDir::new("newest");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        visit(&store);
        let newest = visit(&store);
        age(&store);
        store
            .prune_batch(
                at("2100-01-01T00:00:00.000Z"),
                NonZeroU32::new(1000).unwrap(),
            )
            .unwrap();
        assert_eq!(ids(&store), [newest]);
        assert_eq!(append(&mut store, &created(task(1), None)), newest + 1);
        let epoch = store.reads().epoch().unwrap();
        assert_eq!(store.reads().cursor_fault(&epoch, newest).unwrap(), None);
    }

    #[test]
    fn retires_a_long_backlog_in_bounded_batches_each_moving_the_watermark_up() {
        let dir = TempDir::new("batches");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let ids: Vec<u64> = (0..10).map(|_| visit(&store)).collect();
        age(&store);
        let epoch = store.reads().epoch().unwrap();
        let watched = ids[5];
        let mut faults = Vec::new();
        while store
            .prune_batch(at(CUTOFF), NonZeroU32::new(2).unwrap())
            .unwrap()
        {
            faults.push(store.reads().cursor_fault(&epoch, watched).unwrap());
        }
        let stale = Some(ResetReason::Stale);
        assert_eq!(faults, [None, None, None, stale, stale]);
        assert_eq!(store.reads().cursor_fault(&epoch, ids[9]).unwrap(), None);
    }

    #[test]
    fn streams_only_a_types_streamed_keys_in_its_order_whatever_the_values_hold() {
        let corrupt = stored(
            "task.created",
            "task",
            r#"{"brief":{"secret":true},"extra":1,"parentTaskId":7,"title":["x"],"title":"t"}"#,
        );
        assert_eq!(
            streamed_payload(&corrupt),
            r#"{"title":"t","parentTaskId":7}"#
        );
        let unported = stored(
            "mailbox.queued",
            "message",
            r#"{"body":"hi","from":{"z":1,"a":2.50},"agentId":"agent_1"}"#,
        );
        assert_eq!(
            streamed_payload(&unported),
            r#"{"agentId":"agent_1","from":{"z":1,"a":2.50}}"#
        );
    }

    #[test]
    fn refuses_to_stream_a_type_no_build_registered_or_a_payload_that_isnt_an_object() {
        let refusals = [
            stored("task.exploded", "task", "{}").frame(),
            stored("task.created", "agent", "{}").frame(),
            stored("task.created", "task", r#""brief""#).frame(),
            stored("task.created", "task", "{").frame(),
        ];
        assert!(matches!(refusals[0], Err(FrameError::Unregistered { .. })));
        assert!(matches!(refusals[1], Err(FrameError::Unregistered { .. })));
        assert!(matches!(refusals[2], Err(FrameError::Malformed { .. })));
        assert!(matches!(refusals[3], Err(FrameError::Malformed { .. })));
    }

    #[test]
    fn answers_a_repeated_key_with_its_first_answer_and_refuses_it_for_another_request() {
        let dir = TempDir::new("once");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let mut runs = 0;
        let mut create = |store: &mut Store, request: &str| {
            store.once("k", request, |w| -> Result<u64, OnceError> {
                runs += 1;
                Ok(w.append(&created(task(runs), None)).unwrap())
            })
        };
        let first = create(&mut store, r#"{"caller":null}"#).unwrap();
        let again = create(&mut store, r#"{"caller":null}"#).unwrap();
        let other = create(&mut store, r#"{"caller":"agent_1"}"#);
        assert_eq!((first, again), (1, 1));
        assert!(matches!(other, Err(OnceError::Conflict(_))));
        assert_eq!(store.reads().latest_event_id().unwrap(), 1);
    }

    #[test]
    fn records_no_answer_for_a_mutation_that_failed() {
        let dir = TempDir::new("once-failed");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        let failed: Result<u64, OnceError> =
            store.once("k", "{}", |_| Err(OnceError::Conflict("inner".to_owned())));
        assert!(failed.is_err());
        let ran: Result<u64, OnceError> = store.once("k", "{}", |_| Ok(5));
        assert_eq!(ran.unwrap(), 5);
    }

    #[test]
    fn refuses_to_replay_a_kept_answer_that_holds_no_response() {
        let dir = TempDir::new("once-unanswered");
        let mut store = Store::open(&dir.db("bazhen.db")).unwrap();
        store
            .db
            .execute(
                "INSERT INTO idempotency_keys (key, response) VALUES ('k', '{\"request\":\"{}\"}')",
                (),
            )
            .unwrap();
        let replayed: Result<Option<u64>, OnceError> =
            store.once("k", "{}", |_| panic!("a repeat runs nothing"));
        assert!(
            matches!(replayed, Err(OnceError::Unreadable { ref key, .. }) if key == "k"),
            "{replayed:?}"
        );
    }

    mod any_row {
        use bazhen_protocol::events::EVENT_KINDS;
        use proptest::prelude::*;

        use super::*;

        /// A payload of keys a type streams and keys it doesn't, with any JSON values.
        fn payload() -> impl Strategy<Value = String> {
            let key = prop_oneof![
                Just("title"),
                Just("brief"),
                Just("body"),
                Just("text"),
                Just("note"),
                Just("agentId"),
                Just("path"),
                Just("secret"),
                Just("ti\\u0074le"),
            ];
            let value = prop_oneof![
                Just("null"),
                Just("7"),
                Just("\"s\""),
                Just("[1,{\"a\":2}]"),
                Just("{\"x\":\"y\"}"),
            ];
            prop::collection::vec((key, value), 0..8).prop_map(|pairs| {
                let fields: Vec<String> =
                    pairs.iter().map(|(k, v)| format!("\"{k}\":{v}")).collect();
                format!("{{{}}}", fields.join(","))
            })
        }

        proptest! {
            #[test]
            fn sends_only_the_keys_its_type_streams_whatever_a_row_holds(
                kind in prop::sample::select(EVENT_KINDS.to_vec()),
                payload in payload(),
            ) {
                let event = StoredEvent { kind: kind.name.to_owned(), entity_type: kind.entity.to_owned(), ..stored("", "", &payload) };
                let frame: serde_json::Value = serde_json::from_str(&event.frame().unwrap()).unwrap();
                let sent = frame["event"]["payload"].as_object().unwrap();
                prop_assert!(sent.keys().all(|k| kind.streamed.contains(&k.as_str())), "{frame}");
            }

            #[test]
            fn refuses_or_frames_any_text_without_panicking(payload in ".{0,40}") {
                let _ = stored("task.created", "task", &payload).frame();
            }
        }
    }
}

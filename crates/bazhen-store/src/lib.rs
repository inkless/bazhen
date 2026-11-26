//! The daemon's SQLite seam: the one database a home has, opened privately and migrated to the
//! schema the TypeScript daemon gives it (`apps/daemon/src/store/store.ts`), so either daemon opens
//! the other's database. Blocking, as `SQLite` is: an async caller runs it on a thread of its own.

mod agent_events;
#[cfg(test)]
mod agent_events_fixture;
mod agent_snapshot;
mod agents;
mod attachments;
mod attention;
mod devices;
mod events;
#[cfg(test)]
mod events_fixture;
#[cfg(test)]
mod fixture;
mod hooks;
mod mail;
mod mail_events;
mod mailbox;
mod migrations;
mod private;
mod projections;
mod readiness;
mod snapshot;
mod task_events;
mod task_reads;
mod task_verbs;
mod tasks;
mod terminals;
#[cfg(test)]
mod testing;

use std::cell::Cell;
use std::collections::BTreeSet;
use std::io::Read;
use std::path::{Path, PathBuf};

use bazhen_protocol::ids::HostId;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use serde::Serialize;
use serde::de::DeserializeOwned;

pub use agent_events::AgentChange;
pub use agent_snapshot::{AgentView, AttentionView, Evidence, Listener, OpenAttention};
pub use agents::{AgentLaunch, LiveTerminal, Rename, RenameError};
pub use attention::AttentionItem;
/// Every event type, with the payload keys a frame of it keeps.
pub use bazhen_protocol::events::EVENT_KINDS;
pub use devices::{
    DeviceRow, DismissError, Dismissal, LOOPBACK_IDLE, NewDevice, PairError, Paired, RevokeError,
    Revoked, SECURE_IDLE, TOUCH_EVERY, Viewer,
};
pub use events::{
    Actor, AppendError, FrameError, NewEvent, OnceError, Page, Reads, StoredEvent, TerminalChange,
    Writer,
};
pub use hooks::{AgentBinding, MAX_TRANSCRIPT_PATH};
pub use mail::IN_FLIGHT;
pub use mail_events::{AttentionChange, MailChange};
pub use mailbox::{Mail, Message, ObservedSend, Sender};
pub use migrations::{MIGRATIONS, Migration, NUMBERED_MIGRATIONS};
pub use readiness::{STARTS, Waiting};
pub use snapshot::{SnapshotError, SnapshotView};
pub use task_events::{AssignmentChange, TaskChange};
pub use task_reads::{Stranded, TaskReadError};
pub use task_verbs::{NewGrant, NewNote, TaskVerbError};
pub use tasks::{Assigning, CreateTaskError, MadeTask, NewTask};
pub use terminals::{AgentTerminal, RuntimeRow, ShellRow, start_unsettled, takes_exit};

/// What `schema_version` holds once migrations are named: past every version a build that
/// numbered them supports, so such a build refuses the database rather than re-run its first.
pub const NAMED_MIGRATIONS_VERSION: i64 = 1000;

/// Each pragma the store sets on opening a database, as store.ts sets them, and why: NORMAL loses
/// only what an OS crash would, a shell's last command is zeroed in its page once replaced, and the
/// WAL is truncated after each checkpoint rather than keep old frames.
const PRAGMAS: [(&str, &str); 6] = [
    ("journal_mode", "WAL"),
    ("synchronous", "NORMAL"),
    ("foreign_keys", "ON"),
    ("busy_timeout", "5000"),
    ("secure_delete", "FAST"),
    ("journal_size_limit", "0"),
];

/// Why a database wasn't opened.
#[derive(Debug, thiserror::Error)]
pub enum OpenError {
    /// The database or a journal beside it is something this user mustn't take over.
    #[error("refusing to open {} as Bazhen's database: {reason}", path.display())]
    Unsafe { path: PathBuf, reason: String },
    /// The database has run migrations this build doesn't know, so a newer build wrote it.
    #[error("database has migrations this build doesn't know, from a newer one: {}", .0.join(", "))]
    SchemaTooNew(Vec<String>),
    /// The database's host id isn't one, so whatever wrote it wasn't a Bazhen daemon.
    #[error("database's host id isn't one: {0:?}")]
    HostId(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Sqlite(#[from] rusqlite::Error),
}

/// An open database, migrated, with this installation's host id. Dropping it closes the database,
/// checkpointing its WAL.
#[derive(Debug)]
pub struct Store {
    db: Connection,
    host: Option<HostId>,
    missed: Vec<String>,
    /// Every event a projection still points at; retention keeps them, as it keeps projections.
    referenced: String,
}

impl Store {
    /// The database at `path`, made private and migrated through every migration.
    ///
    /// # Errors
    ///
    /// [`OpenError`]: a file this user mustn't take over, a newer build's database, or `SQLite`'s.
    pub fn open(path: &Path) -> Result<Self, OpenError> {
        Self::open_with(path, MIGRATIONS)
    }

    /// The database at `path`, migrated through `migrations` only.
    ///
    /// # Errors
    ///
    /// As [`Store::open`].
    pub fn open_with(path: &Path, migrations: &[Migration]) -> Result<Self, OpenError> {
        private::keep_private(path, rustix::process::getuid().as_raw())?;
        let db = Connection::open(path)?;
        for (pragma, value) in PRAGMAS {
            db.pragma_update_and_check(None, pragma, value, |_| Ok(()))
                .optional()?;
        }
        db.execute_batch(
            "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL) STRICT",
        )?;
        let mut store = Self {
            db,
            host: None,
            missed: Vec::new(),
            referenced: String::new(),
        };
        store.migrate(migrations)?;
        store.host = store.ensure_host()?;
        store.referenced = events::referenced_events(&store.db)?;
        Ok(store)
    }

    /// Reads of the database on this connection.
    pub fn reads(&self) -> Reads<'_> {
        Reads(&self.db)
    }

    /// Runs `write` in one transaction, committed only when it answers `Ok`.
    ///
    /// # Errors
    ///
    /// `write`'s, or `SQLite`'s beginning or committing.
    pub fn write<T, E: From<rusqlite::Error>>(
        &mut self,
        write: impl FnOnce(&Writer<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        let (out, scrub) = {
            let writer = Writer {
                tx: self
                    .db
                    .transaction_with_behavior(TransactionBehavior::Immediate)?,
                host: self.host.as_ref().map(HostId::as_str),
                scrub: Cell::new(false),
            };
            let out = write(&writer)?;
            let scrub = writer.scrub.get();
            writer.tx.commit()?;
            (out, scrub)
        };
        if scrub {
            self.scrub_journal();
        }
        Ok(out)
    }

    /// Writes the WAL into the database and truncates it, so a shell's cleared line, zeroed in the
    /// database's page by `secure_delete`, keeps no earlier copy in the journal. A reader holding
    /// the WAL open leaves it for the next checkpoint, which `journal_size_limit` truncates as
    /// well.
    fn scrub_journal(&self) {
        let truncated = self
            .db
            .query_row("PRAGMA wal_checkpoint(TRUNCATE)", (), |row| {
                row.get::<_, i64>(0)
            });
        if let Err(err) = truncated {
            // The line is cleared and committed either way; only its earlier copy waits for the
            // next checkpoint.
            tracing::warn!(
                "the WAL could not be truncated after a shell's line was cleared: {err}"
            );
        }
    }

    /// Runs `write` as [`Store::write`] does, its commit flushed to disk before this answers, so
    /// no crash of the machine loses it.
    ///
    /// # Errors
    ///
    /// As [`Store::write`], or `SQLite`'s setting how commits are flushed.
    pub(crate) fn write_durable<T, E: From<rusqlite::Error>>(
        &mut self,
        write: impl FnOnce(&Writer<'_>) -> Result<T, E>,
    ) -> Result<T, E> {
        self.db.pragma_update(None, "synchronous", "FULL")?;
        let out = self.write(write);
        let restored = self.db.pragma_update(None, "synchronous", "NORMAL");
        let out = out?;
        restored?;
        Ok(out)
    }

    /// Runs a mutation once per idempotency key: a repeat of the same `request` gets the first
    /// answer, and the same key for another request is refused. `request` is the request's JSON
    /// text, as the TypeScript daemon writes it, so a key either daemon recorded replays in the
    /// other. The answer is recorded in the transaction that makes the mutation.
    ///
    /// # Errors
    ///
    /// `mutate`'s, or [`OnceError`] as `E`.
    pub fn once<R, E>(
        &mut self,
        key: &str,
        request: &str,
        mutate: impl FnOnce(&Writer<'_>) -> Result<R, E>,
    ) -> Result<R, E>
    where
        R: Serialize + DeserializeOwned,
        E: From<OnceError> + From<rusqlite::Error>,
    {
        self.write(|writer| {
            if let Some(prior) = events::replay(writer.connection(), key, request)? {
                return Ok(prior);
            }
            let response = mutate(writer)?;
            events::answered(writer.connection(), key, request, &response)?;
            Ok(response)
        })
    }

    /// Retires up to `limit` events recorded before `cutoff`, and answers whether more may wait.
    ///
    /// # Errors
    ///
    /// `SQLite`'s; nothing is retired then.
    pub fn prune_batch(
        &mut self,
        cutoff: jiff::Timestamp,
        limit: std::num::NonZeroU32,
    ) -> rusqlite::Result<bool> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let more = events::prune_batch(&tx, &self.referenced, &iso(cutoff), limit)?;
        tx.commit()?;
        Ok(more)
    }

    /// This installation's host id, minted on first open; none while the schema has no host.
    pub fn host_id(&self) -> Option<&HostId> {
        self.host.as_ref()
    }

    /// The migrations this open ran after later ones the database had already run, which the
    /// daemon says it did.
    pub fn missed(&self) -> &[String] {
        &self.missed
    }

    /// The names of the migrations the database has run.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn applied_migrations(&self) -> Result<BTreeSet<String>, rusqlite::Error> {
        applied(&self.db)
    }

    fn migrate(&mut self, migrations: &[Migration]) -> Result<(), OpenError> {
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        name_numbered_migrations(&tx)?;
        tx.commit()?;
        let done = applied(&self.db)?;
        let unknown: Vec<String> = done
            .iter()
            .filter(|name| !migrations.iter().any(|m| m.name == name.as_str()))
            .cloned()
            .collect();
        if !unknown.is_empty() {
            return Err(OpenError::SchemaTooNew(unknown));
        }
        self.missed = hole_fills(migrations, &done);
        for m in migrations.iter().filter(|m| !done.contains(m.name)) {
            let tx = self
                .db
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            tx.execute_batch(m.sql)?;
            if let Some(run) = m.run {
                run(&tx)?;
            }
            tx.execute(
                "INSERT INTO migrations (name, applied_at) VALUES (?, ?)",
                (m.name, now()),
            )?;
            tx.commit()?;
        }
        Ok(())
    }

    fn ensure_host(&self) -> Result<Option<HostId>, OpenError> {
        let has_table = self
            .db
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'host'",
                (),
                |_| Ok(()),
            )
            .optional()?;
        if has_table.is_none() {
            return Ok(None);
        }
        let existing: Option<String> = self
            .db
            .query_row("SELECT id FROM host LIMIT 1", (), |row| row.get(0))
            .optional()?;
        if let Some(id) = existing {
            return HostId::parse(&id).map(Some).ok_or(OpenError::HostId(id));
        }
        let id = HostId::mint(now_ms(), urandom()?);
        self.db.execute(
            "INSERT INTO host (id, created_at) VALUES (?, ?)",
            (id.as_str(), now()),
        )?;
        Ok(Some(id))
    }
}

/// A connection that only reads a database the daemon's [`Store`] opened, for reads that mustn't
/// wait behind its writes.
#[derive(Debug)]
pub struct Reader {
    db: Connection,
}

impl Reader {
    /// A read-only connection to the database at `path`.
    ///
    /// # Errors
    ///
    /// `SQLite`'s.
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let db = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )?;
        db.busy_timeout(std::time::Duration::from_secs(5))?;
        Ok(Self { db })
    }

    pub fn reads(&self) -> Reads<'_> {
        Reads(&self.db)
    }
}

fn applied(db: &Connection) -> Result<BTreeSet<String>, rusqlite::Error> {
    db.prepare("SELECT name FROM migrations")?
        .query_map((), |row| row.get(0))?
        .collect()
}

/// Records, by name, the migrations a database the numbering runner left at version n has run:
/// the first n. Then marks `schema_version` so that runner refuses it.
fn name_numbered_migrations(db: &Connection) -> Result<(), OpenError> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL) STRICT",
    )?;
    let version: i64 = db.query_row(
        "SELECT coalesce(max(version), 0) FROM schema_version",
        (),
        |row| row.get(0),
    )?;
    if version == NAMED_MIGRATIONS_VERSION {
        return Ok(());
    }
    let numbered = usize::try_from(version)
        .ok()
        .and_then(|v| NUMBERED_MIGRATIONS.get(..v))
        .ok_or_else(|| OpenError::SchemaTooNew(vec![format!("version {version}")]))?;
    let at = now();
    for name in numbered {
        db.execute(
            "INSERT OR IGNORE INTO migrations (name, applied_at) VALUES (?, ?)",
            (name, &at),
        )?;
    }
    db.execute("DELETE FROM schema_version", ())?;
    db.execute(
        "INSERT INTO schema_version (version) VALUES (?)",
        [NAMED_MIGRATIONS_VERSION],
    )?;
    Ok(())
}

/// The migrations a database hasn't run that come before one it has: run now, they follow
/// migrations a fresh database runs after them, which is safe only because parallel migrations
/// commute.
fn hole_fills(migrations: &[Migration], done: &BTreeSet<String>) -> Vec<String> {
    let last = migrations.iter().rposition(|m| done.contains(m.name));
    migrations
        .get(..last.unwrap_or(0))
        .unwrap_or_default()
        .iter()
        .filter(|m| !done.contains(m.name))
        .map(|m| m.name.to_owned())
        .collect()
}

/// 16 random bytes from the kernel.
fn urandom() -> std::io::Result<[u8; 16]> {
    let mut random = [0u8; 16];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut random)?;
    Ok(random)
}

/// Now, as `new Date().toISOString()` writes it.
pub(crate) fn now() -> String {
    iso(jiff::Timestamp::now())
}

/// `at` as `Date.prototype.toISOString` writes it, which is how every stored time is written, so
/// two compare as text as they do as times.
fn iso(at: jiff::Timestamp) -> String {
    format!("{at:.3}")
}

fn now_ms() -> u64 {
    u64::try_from(jiff::Timestamp::now().as_millisecond()).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flushes_a_durable_write_as_it_commits_and_only_that_write() {
        let dir = testing::TempDir::new("durable");
        let mut store = Store::open(&dir.db("a.db")).unwrap();
        let synchronous = |db: &Connection| -> i64 {
            db.pragma_query_value(None, "synchronous", |row| row.get(0))
                .unwrap()
        };
        let during = store
            .write_durable(|w| -> rusqlite::Result<i64> { Ok(synchronous(w.connection())) })
            .unwrap();
        let failed: rusqlite::Result<()> =
            store.write_durable(|_| Err(rusqlite::Error::InvalidQuery));
        assert!(failed.is_err());
        // FULL is 2, NORMAL 1.
        assert_eq!((during, synchronous(&store.db)), (2, 1));
    }

    #[test]
    fn now_is_written_as_javascripts_iso_string() {
        let at = now();
        assert_eq!(at.len(), "2026-11-18T01:02:03.456Z".len(), "{at}");
        assert!(at.ends_with('Z') && at.get(19..20) == Some("."), "{at}");
    }
}

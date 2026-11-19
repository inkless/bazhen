//! The Rust store against what `pnpm schema` records of the TypeScript one
//! (packages/protocol/fixtures/store/): the same migrations, each with code where it has code, the
//! same pragmas, the same schema from any starting point, and the same rows from each migration
//! with code of its own. A migration added to the TypeScript daemon fails here until it is added
//! here too.

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};

use crate::{
    MIGRATIONS, Migration, NAMED_MIGRATIONS_VERSION, NUMBERED_MIGRATIONS, OpenError, PRAGMAS, Store,
};
use rusqlite::Connection;
use serde_json::{Value, json};

fn fixture() -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../packages/protocol/fixtures/store/typescript.json");
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// A directory of the test's own, removed when the test ends, whether or not it passed.
struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
        let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!(
            "bz-store-fixture-{name}-{}-{n}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).unwrap();
        Self(dir)
    }

    fn db(&self, name: &str) -> PathBuf {
        self.0.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        // A directory left in the temp dir costs nothing a test would see.
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn open(path: &Path, migrations: &[Migration]) -> Store {
    Store::open_with(path, migrations).unwrap()
}

fn json_of(value: rusqlite::types::ValueRef<'_>) -> Value {
    match value {
        rusqlite::types::ValueRef::Null => Value::Null,
        rusqlite::types::ValueRef::Integer(n) => json!(n),
        rusqlite::types::ValueRef::Text(t) => json!(std::str::from_utf8(t).unwrap()),
        other => panic!("unexpected {other:?}"),
    }
}

fn query(path: &Path, sql: &str) -> Vec<Value> {
    let db = Connection::open(path).unwrap();
    let mut stmt = db.prepare(sql).unwrap();
    let names: Vec<String> = stmt.column_names().map(str::to_owned).collect();
    stmt.query_map((), |row| {
        let mut object = serde_json::Map::new();
        for (i, name) in names.iter().enumerate() {
            object.insert(name.clone(), json_of(row.get_ref(i)?));
        }
        Ok(Value::Object(object))
    })
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

fn schema(path: &Path) -> Value {
    Value::Array(query(
        path,
        "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name",
    ))
}

fn every_name() -> BTreeSet<String> {
    MIGRATIONS.iter().map(|m| m.name.to_owned()).collect()
}

fn index_of(name: &str) -> usize {
    MIGRATIONS.iter().position(|m| m.name == name).unwrap()
}

#[test]
fn runs_the_typescript_daemons_migrations_byte_for_byte_in_its_order() {
    let fixture = fixture();
    let ours: Vec<Value> = MIGRATIONS
        .iter()
        .map(|m| json!({ "name": m.name, "sql": m.sql, "run": m.run.is_some() }))
        .collect();
    assert_eq!(Value::Array(ours), fixture["migrations"]);
    assert_eq!(json!(NUMBERED_MIGRATIONS), fixture["numbered"]);
    assert_eq!(
        json!(NAMED_MIGRATIONS_VERSION),
        fixture["namedMigrationsVersion"]
    );
}

#[test]
fn a_fresh_database_gets_the_typescript_daemons_schema_and_a_host() {
    let dir = TempDir::new("fresh");
    let path = dir.db("a.db");
    let store = open(&path, MIGRATIONS);
    assert_eq!(store.applied_migrations().unwrap(), every_name());
    assert_eq!(store.missed(), [] as [String; 0]);
    let host = store.host_id().unwrap().clone();
    drop(store);
    assert_eq!(schema(&path), fixture()["schema"]);
    let again = Store::open(&path).unwrap();
    assert_eq!(again.host_id(), Some(&host));
    assert_eq!(
        query(&path, "SELECT count(*) AS n FROM host"),
        [json!({"n": 1})]
    );
}

#[test]
fn a_database_migrated_part_way_ends_with_the_same_schema() {
    let fixture = fixture();
    let dir = TempDir::new("partway");
    for upto in 0..MIGRATIONS.len() {
        let path = dir.db(&format!("{upto}.db"));
        drop(open(&path, MIGRATIONS.get(..upto).unwrap()));
        let store = Store::open(&path).unwrap();
        assert_eq!(store.missed(), [] as [String; 0], "from {upto}");
        drop(store);
        assert_eq!(schema(&path), fixture["schema"], "from {upto}");
    }
}

#[test]
fn opens_a_database_with_the_typescript_daemons_pragmas_as_sqlite_reads_them_back() {
    let fixture = fixture();
    let ours: Vec<Value> = PRAGMAS
        .iter()
        .map(|(name, value)| json!({ "name": name, "value": value }))
        .collect();
    let theirs: Vec<Value> = fixture["pragmas"]
        .as_array()
        .unwrap()
        .iter()
        .map(|p| json!({ "name": p["name"], "value": p["value"] }))
        .collect();
    assert_eq!(ours, theirs);
    let dir = TempDir::new("pragmas");
    let store = Store::open(&dir.db("a.db")).unwrap();
    for pragma in fixture["pragmas"].as_array().unwrap() {
        let name = pragma["name"].as_str().unwrap();
        let read = store
            .db
            .pragma_query_value(None, name, |row| Ok(json_of(row.get_ref(0)?)))
            .unwrap();
        assert_eq!(read, pragma["reads"], "{name}");
    }
}

/// Each migration with code, run on the rows the TypeScript fixture seeded before it, ends with
/// the rows the TypeScript migration made of them; and each such migration has a seed.
#[test]
fn each_migration_with_code_makes_what_the_typescript_one_did_of_a_databases_rows() {
    let fixture = fixture();
    let hooks = fixture["hooks"].as_object().unwrap();
    let hooked: Vec<&str> = MIGRATIONS
        .iter()
        .filter(|m| m.run.is_some())
        .map(|m| m.name)
        .collect();
    assert_eq!(hooks.keys().map(String::as_str).collect::<Vec<_>>(), hooked);
    let dir = TempDir::new("hooks");
    for (name, hook) in hooks {
        let path = dir.db(&format!("{name}.db"));
        drop(open(&path, MIGRATIONS.get(..index_of(name)).unwrap()));
        Connection::open(&path)
            .unwrap()
            .execute_batch(hook["seed"].as_str().unwrap())
            .unwrap();
        drop(Store::open(&path).unwrap());
        for result in hook["results"].as_array().unwrap() {
            let sql = result["sql"].as_str().unwrap();
            assert_eq!(json!(query(&path, sql)), result["rows"], "{name}: {sql}");
        }
    }
}

#[test]
fn refuses_a_database_whose_host_id_isnt_one() {
    let dir = TempDir::new("host");
    let path = dir.db("a.db");
    drop(open(&path, MIGRATIONS));
    Connection::open(&path)
        .unwrap()
        .execute("UPDATE host SET id = 'host_nope'", ())
        .unwrap();
    assert_eq!(
        Store::open(&path).unwrap_err().to_string(),
        "database's host id isn't one: \"host_nope\""
    );
}

/// A database as the runner that numbered migrations left it at `version`: the first `version`
/// run, and each recorded by its number in `schema_version`.
fn numbered_at(path: &Path, version: usize) {
    let mut db = Connection::open(path).unwrap();
    db.execute_batch(
        "PRAGMA foreign_keys = ON; CREATE TABLE schema_version (version INTEGER NOT NULL) STRICT",
    )
    .unwrap();
    for (i, m) in MIGRATIONS.iter().take(version).enumerate() {
        let tx = db.transaction().unwrap();
        tx.execute_batch(m.sql).unwrap();
        if let Some(run) = m.run {
            run(&tx).unwrap();
        }
        tx.execute(
            "INSERT INTO schema_version (version) VALUES (?)",
            [i64::try_from(i).unwrap() + 1],
        )
        .unwrap();
        tx.commit().unwrap();
    }
}

#[test]
fn upgrades_a_database_the_numbering_runner_left_at_any_version() {
    let fixture = fixture();
    let dir = TempDir::new("numbered");
    for version in 0..=NUMBERED_MIGRATIONS.len() {
        let path = dir.db(&format!("{version}.db"));
        numbered_at(&path, version);
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.applied_migrations().unwrap(),
            every_name(),
            "{version}"
        );
        drop(store);
        assert_eq!(schema(&path), fixture["schema"], "{version}");
        assert_eq!(
            query(&path, "SELECT version FROM schema_version"),
            [json!({ "version": NAMED_MIGRATIONS_VERSION })]
        );
    }
}

#[test]
fn refuses_a_database_the_numbering_runner_left_past_its_last_changing_nothing() {
    let dir = TempDir::new("past");
    let path = dir.db("a.db");
    numbered_at(&path, NUMBERED_MIGRATIONS.len());
    let past = i64::try_from(NUMBERED_MIGRATIONS.len()).unwrap() + 1;
    Connection::open(&path)
        .unwrap()
        .execute("UPDATE schema_version SET version = ?", [past])
        .unwrap();
    let before = schema(&path);
    let err = Store::open(&path).unwrap_err();
    assert!(
        matches!(&err, OpenError::SchemaTooNew(unknown) if *unknown == [format!("version {past}")]),
        "{err:?}"
    );
    assert_eq!(schema(&path), before);
}

#[test]
fn refuses_a_database_with_a_migration_this_build_doesnt_know() {
    let dir = TempDir::new("newer");
    let path = dir.db("a.db");
    drop(open(&path, MIGRATIONS));
    Connection::open(&path)
        .unwrap()
        .execute(
            "INSERT INTO migrations (name, applied_at) VALUES ('2099-01-01-later', 'x')",
            (),
        )
        .unwrap();
    let err = Store::open(&path).unwrap_err();
    assert_eq!(
        err.to_string(),
        "database has migrations this build doesn't know, from a newer one: 2099-01-01-later"
    );
}

#[test]
fn runs_a_migration_the_database_missed_after_later_ones_and_says_which() {
    let dir = TempDir::new("missed");
    let path = dir.db("a.db");
    let missed = "2026-11-15-terminal-runtime-kind";
    let without: Vec<Migration> = MIGRATIONS
        .iter()
        .copied()
        .filter(|m| m.name != missed)
        .collect();
    drop(open(&path, &without));
    let store = Store::open(&path).unwrap();
    assert_eq!(store.missed(), [missed]);
    assert_eq!(store.applied_migrations().unwrap(), every_name());
    drop(store);
}

#[test]
fn keeps_nothing_of_a_migration_that_fails_partway_and_records_nothing_of_it() {
    let dir = TempDir::new("fails");
    let path = dir.db("a.db");
    let failing = Migration {
        name: "2099-01-01-fails",
        sql: "CREATE TABLE half (a INTEGER) STRICT; SELECT * FROM nowhere;",
        run: None,
    };
    let list: Vec<Migration> = MIGRATIONS
        .iter()
        .copied()
        .chain(std::iter::once(failing))
        .collect();
    assert!(matches!(
        Store::open_with(&path, &list),
        Err(OpenError::Sqlite(_))
    ));
    assert_eq!(schema(&path), fixture()["schema"]);
    let store = Store::open(&path).unwrap();
    assert_eq!(store.applied_migrations().unwrap(), every_name());
}

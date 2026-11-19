import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InvalidTransition, newId, type ResumeEvidence } from "@bazhen/core";
import { TerminalState, type ExternalRef } from "@bazhen/protocol";
import {
  age,
  claudeAgent,
  fakeEnvironment,
  loopbackPairing,
  PANE_PID,
  register,
  resumesClaude,
  ready,
  settled,
  testView,
  visit,
  withAgent,
} from "../testing/fixtures.ts";
import { MIGRATIONS, NUMBERED_MIGRATIONS, type Migration } from "./migrations.ts";
import { UnknownEntity } from "./projections.ts";
import {
  AGENT_BY_TERMINAL,
  NAMED_MIGRATIONS_VERSION,
  SchemaTooNew,
  Store,
  UnknownAgent,
  UnsafeDatabase,
} from "./store.ts";

const dbPath = () => join(mkdtempSync(join(tmpdir(), "bz-store-")), "bazhen.db");

const withEnvironment = (store: Store) => register(store).environmentId;

function launch(store: Store, environmentId: string) {
  const agentId = newId("agent");
  const terminalId = newId("term");
  store.append({
    type: "agent.launched",
    entityId: agentId,
    actor: "system",
    payload: { environmentId, harness: "claude-code", project: "p", cwd: "/work", terminalId },
  });
  return { agentId, terminalId };
}

const running = (agentId: string) => ({
  type: "agent.running" as const,
  entityId: agentId,
  actor: "system",
  payload: { externalRef: null, runtimeRef: { runtime: "tmux", locator: { session: "bz-1" } } },
});

const shellOpened = (terminalId: string, environmentId: string, linkedAgentId: string | null) =>
  ({
    type: "terminal.opened",
    entityId: terminalId,
    actor: "user",
    payload: { environmentId, cwd: "/work", linkedAgentId },
  }) as const;

/**
 * Leaves `path` as a daemon killed with a live WAL would, made before databases were private:
 * the database and both journals on disk, 0644.
 */
function leftByKilledDaemon(path: string): void {
  const killed = Store.open(path);
  withEnvironment(killed);
  const journals = [`${path}-wal`, `${path}-shm`].map((file) => ({
    file,
    bytes: readFileSync(file),
  }));
  killed.close();
  for (const { file, bytes } of journals) writeFileSync(file, bytes, { mode: 0o644 });
  for (const file of [path, ...journals.map((j) => j.file)]) chmodSync(file, 0o644);
}

function runningShell(store: Store) {
  const terminalId = newId("term");
  store.append(shellOpened(terminalId, withEnvironment(store), null));
  store.append({
    type: "terminal.running",
    entityId: terminalId,
    actor: "system",
    payload: { runtimeRef: { runtime: "tmux", locator: { generation: "0" } } },
  });
  return terminalId;
}

const shellEvent = (terminalId: string, type: "terminal.closing" | "terminal.lost") =>
  ({ type, entityId: terminalId, actor: "system", payload: {} }) as const;

const EVERY_MIGRATION = new Set(MIGRATIONS.map((m) => m.name));

/**
 * A database as the runner that numbered migrations left it at `version`: the first `version`
 * run, and each recorded by its number in `schema_version`.
 */
function numberedAt(path: string, version: number): void {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL) STRICT");
  for (const [i, m] of MIGRATIONS.slice(0, version).entries()) {
    db.exec("BEGIN");
    db.exec(m.sql);
    m.run?.(db);
    db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(i + 1);
    db.exec("COMMIT");
  }
  db.close();
}

function read<T>(path: string, query: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return query(db);
  } finally {
    db.close();
  }
}

const schemaOf = (path: string) =>
  read(path, (db) =>
    db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name").all(),
  );

/** SQL as SQLite keeps it, without comments, and with each run of whitespace one space. */
const squeezed = (sql: unknown) =>
  (typeof sql === "string" ? sql : "")
    .replaceAll(/--[^\n]*/g, "")
    .replaceAll(/\s+/g, " ")
    .trim();

/** The CHECK constraints in a table's `CREATE TABLE`, each as written, in order. */
function checksOf(sql: unknown): string[] {
  const text = squeezed(sql);
  return [...text.matchAll(/\bCHECK\s*\(/gi)]
    .map((m) => {
      let depth = 0;
      const from = m.index + m[0].length - 1;
      for (let i = from; i < text.length; i += 1) {
        if (text[i] === "(") depth += 1;
        if (text[i] === ")") depth -= 1;
        if (depth === 0) return text.slice(from, i + 1);
      }
      return text.slice(from);
    })
    .toSorted();
}

/**
 * What a database's schema means, whatever order its columns were added in: each table's columns
 * with their keys, its foreign keys and checks; each index's table, uniqueness, keys and condition;
 * and each trigger and view as written.
 */
const shapeOf = (path: string) =>
  read(path, (db) =>
    db
      .prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY name")
      .all()
      .map(({ type, name, tbl_name, sql }) => {
        const id = String(name);
        if (type === "table") {
          return {
            type,
            name,
            columns: db
              .prepare(
                `SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY name`,
              )
              .all(id),
            foreignKeys: db
              .prepare(
                `SELECT "table", "from", "to", on_update, on_delete, "match"
                   FROM pragma_foreign_key_list(?) ORDER BY "from", "table", "to"`,
              )
              .all(id),
            checks: checksOf(sql),
          };
        }
        if (type === "index") {
          return {
            type,
            name,
            table: tbl_name,
            listed: db
              .prepare(`SELECT "unique", origin, partial FROM pragma_index_list(?) WHERE name = ?`)
              .all(String(tbl_name), id),
            keys: db
              .prepare(
                `SELECT seqno, name, "desc", coll, "key" FROM pragma_index_xinfo(?) ORDER BY seqno`,
              )
              .all(id),
            sql: squeezed(sql),
          };
        }
        return { type, name, table: tbl_name, sql: squeezed(sql) };
      }),
  );

/** The shape of a database made by running `sql` on an empty one. */
function shapeOfSql(sql: string) {
  const path = dbPath();
  read(path, (db) => db.exec(sql));
  return shapeOf(path);
}

/**
 * The shape of a database that ran `migrations`, with `last`, if given, run after all the others,
 * as a database that missed it runs it.
 */
function shapeWithLast(migrations: readonly Migration[], last?: Migration) {
  const path = dbPath();
  if (last !== undefined)
    Store.open(
      path,
      migrations.filter((m) => m !== last),
    ).close();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    Store.open(path, migrations).close();
  } finally {
    warn.mockRestore();
  }
  return shapeOf(path);
}

/** The hook process `pid` of session s-1, as a compaction names it. */
const hook = (pid: number) => ({ sessionId: "s-1", pid });

describe("Store migrations", () => {
  it.each(Array.from({ length: NUMBERED_MIGRATIONS.length + 1 }, (_, v) => v))(
    "upgrades a database the numbering runner left at version %i to a fresh one's schema",
    (version) => {
      const fresh = dbPath();
      Store.open(fresh).close();
      const path = dbPath();
      numberedAt(path, version);
      const store = Store.open(path);
      expect(store.appliedMigrations()).toEqual(EVERY_MIGRATION);
      store.close();
      expect(schemaOf(path)).toEqual(schemaOf(fresh));
      expect(read(path, (db) => db.prepare("SELECT version FROM schema_version").all())).toEqual([
        { version: NAMED_MIGRATIONS_VERSION },
      ]);
    },
  );

  it("converts a numbered database in one transaction, or not at all", () => {
    const path = dbPath();
    numberedAt(path, 3);
    // The sentinel's insert, the conversion's last step, fails.
    read(path, (db) =>
      db.exec(`CREATE TRIGGER no_sentinel BEFORE INSERT ON schema_version
                 WHEN NEW.version = ${NAMED_MIGRATIONS_VERSION} BEGIN SELECT RAISE(ABORT, 'no'); END`),
    );
    expect(() => Store.open(path)).toThrow(/no/);
    expect(
      read(path, (db) => [
        db.prepare("SELECT max(version) AS v FROM schema_version").get()?.v,
        db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'migrations'").get()?.n,
      ]),
    ).toEqual([3, 0]);
  });

  it("keeps nothing of a migration that fails partway, and records nothing of it", () => {
    const path = dbPath();
    const half = {
      name: "2099-01-01-half",
      sql: "CREATE TABLE half (x INTEGER) STRICT; SELECT * FROM no_such_table;",
    };
    expect(() => Store.open(path, [...MIGRATIONS, half])).toThrow(/no_such_table/);
    expect(
      read(path, (db) => [
        db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'half'").get()?.n,
        db.prepare("SELECT count(*) AS n FROM migrations WHERE name = ?").get(half.name)?.n,
      ]),
    ).toEqual([0, 0]);
  });

  it("keeps nothing of a migration whose record can't be written", () => {
    const path = dbPath();
    Store.open(path).close();
    const kept = { name: "2099-01-01-kept", sql: "CREATE TABLE kept (x INTEGER) STRICT;" };
    read(path, (db) =>
      db.exec(`CREATE TRIGGER no_record BEFORE INSERT ON migrations
                 WHEN NEW.name = '${kept.name}' BEGIN SELECT RAISE(ABORT, 'no'); END`),
    );
    expect(() => Store.open(path, [...MIGRATIONS, kept])).toThrow(/no/);
    expect(
      read(
        path,
        (db) => db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'kept'").get()?.n,
      ),
    ).toBe(0);
  });

  it("refuses a database the numbering runner left past the last numbered migration", () => {
    const path = dbPath();
    const past = NUMBERED_MIGRATIONS.length + 1;
    numberedAt(path, NUMBERED_MIGRATIONS.length);
    read(path, (db) => db.prepare("INSERT INTO schema_version (version) VALUES (?)").run(past));
    expect(() => Store.open(path)).toThrow(SchemaTooNew);
    // Refused before anything is recorded: a build that knows that version still finds it.
    expect(
      read(path, (db) => [
        db.prepare("SELECT max(version) AS v FROM schema_version").get()?.v,
        db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name = 'migrations'").get()?.n,
      ]),
    ).toEqual([past, 0]);
  });

  it("leaves a database where the runner that numbered migrations refuses it", () => {
    const path = dbPath();
    Store.open(path).close();
    const version = read(
      path,
      (db) => db.prepare("SELECT max(version) AS v FROM schema_version").get()?.v,
    );
    expect(version).toBeGreaterThan(NUMBERED_MIGRATIONS.length);
  });

  it("runs a migration the database missed, though later ones have run", () => {
    const fresh = dbPath();
    Store.open(fresh).close();
    const path = dbPath();
    const missed = "2026-11-15-terminal-runtime-kind";
    Store.open(
      path,
      MIGRATIONS.filter((m) => m.name !== missed),
    ).close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const store = Store.open(path);
    expect(store.appliedMigrations()).toEqual(EVERY_MIGRATION);
    store.close();
    expect(shapeOf(path)).toEqual(shapeOf(fresh));
    expect(warn.mock.calls).toEqual([[expect.stringContaining(missed)]]);
    warn.mockRestore();
  });

  it("says nothing of missed migrations on a fresh database", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    Store.open(dbPath()).close();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("says nothing of missed migrations when there are none", () => {
    const path = dbPath();
    Store.open(path, MIGRATIONS.slice(0, 10)).close();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    Store.open(path).close();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  // Every named migration, run as a database that missed it would: after all the others. It must
  // leave the schema a fresh database has, or one that ran a later migration first loses its work.
  // The newest one's own case is trivial, as it runs last anyway: what this holds starts with the
  // second named migration, run after the first.
  for (const m of MIGRATIONS.slice(NUMBERED_MIGRATIONS.length)) {
    it(`gives the same schema run after every other migration: ${m.name}`, () => {
      expect(shapeWithLast(MIGRATIONS, m)).toEqual(shapeWithLast(MIGRATIONS));
    });
  }

  it("tells schemas apart by each key, check, index, trigger and view, not by column order", () => {
    const parent = "CREATE TABLE p (id INTEGER PRIMARY KEY, k TEXT);";
    const table = (columns: string) => `${parent} CREATE TABLE t (${columns});`;
    const whole = "a INTEGER, b INTEGER REFERENCES p (id), CHECK (a > 0)";
    const rest =
      "CREATE INDEX t_a ON t (a) WHERE a > 1; " +
      "CREATE TRIGGER t_ins AFTER INSERT ON t BEGIN SELECT 1; END; " +
      "CREATE VIEW v AS SELECT a FROM t;";
    const shape = shapeOfSql(`${table(whole)} ${rest}`);
    expect(
      shapeOfSql(`${table("b INTEGER REFERENCES p (id), a INTEGER, CHECK (a > 0)")} ${rest}`),
    ).toEqual(shape);
    expect(
      [
        `${table("a INTEGER, b INTEGER, CHECK (a > 0)")} ${rest}`,
        `${table("a INTEGER, b INTEGER REFERENCES p (id)")} ${rest}`,
        `${table("a INTEGER PRIMARY KEY, b INTEGER REFERENCES p (id), CHECK (a > 0)")} ${rest}`,
        `${table(whole)} ${rest.replace("CREATE INDEX", "CREATE UNIQUE INDEX")}`,
        `${table(whole)} ${rest.replace(" WHERE a > 1", "")}`,
        `${table(whole)} ${rest.replace("SELECT 1;", "SELECT 2;")}`,
        `${table(whole)} ${rest.replace("SELECT a FROM t", "SELECT b FROM t")}`,
      ].map(shapeOfSql),
    ).not.toContainEqual(shape);
  });

  it("finds a migration that undoes a later one when it runs after it", () => {
    // Written apart: the older rebuilds a table with the columns it knew, the newer adds one.
    const rebuild = {
      name: "2099-01-01-rebuild",
      sql: `CREATE TABLE devices_new (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE,
              paired_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, revoked_at TEXT,
              secure INTEGER NOT NULL
            ) STRICT;
            INSERT INTO devices_new SELECT id, name, token_hash, paired_at, last_seen_at,
              revoked_at, secure FROM devices;
            DROP TABLE devices;
            ALTER TABLE devices_new RENAME TO devices;`,
    };
    const added = { name: "2099-01-02-added", sql: "ALTER TABLE devices ADD COLUMN color TEXT;" };
    const list = [...MIGRATIONS, rebuild, added];
    const fresh = shapeWithLast(list);
    expect(shapeWithLast(list, added)).toEqual(fresh);
    expect(shapeWithLast(list, rebuild)).not.toEqual(fresh);
  });
});

describe("Store", () => {
  it("migrates a fresh database to the latest schema, and reopening is a no-op", () => {
    const path = dbPath();
    Store.open(path).close();
    const again = Store.open(path);
    expect(again.appliedMigrations()).toEqual(EVERY_MIGRATION);
    again.close();
  });

  it("refuses a database written by a newer build", () => {
    const path = dbPath();
    Store.open(path, [
      ...MIGRATIONS,
      { name: "2099-01-01-from-a-newer-build", sql: "SELECT 1" },
    ]).close();
    expect(() => Store.open(path)).toThrow(/2099-01-01-from-a-newer-build/);
  });

  it("upgrades a schema-1 database through every migration, keeping its terminals", () => {
    const path = dbPath();
    const v1 = Store.open(path, MIGRATIONS.slice(0, 1));
    const host = v1.hostId();
    v1.close();
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
              VALUES ('${host}', '2026-01-01', 'old', 'terminal', 'term_1', 'system', '{}')`);
    raw.exec(
      `INSERT INTO terminals VALUES ('term_1', '${host}', 'running', 0, 'tmux', '{}', 1, 1)`,
    );
    raw.close();
    const upgraded = Store.open(path);
    expect(upgraded.appliedMigrations()).toEqual(EVERY_MIGRATION);
    upgraded.close();
    const check = new DatabaseSync(path);
    expect(check.prepare("SELECT kind FROM terminals").get()).toEqual({ kind: "agent" });
    const tables = check.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
    expect(tables.map((t) => t.name)).toEqual(expect.arrayContaining(["agent_sessions", "leases"]));
    check.close();
  });

  it("upgrades a schema-12 database to hold shells beside the agents it had", () => {
    const path = dbPath();
    const v13 = Store.open(path, MIGRATIONS.slice(0, 13));
    const { agentId } = launch(v13, withEnvironment(v13));
    v13.close();
    const upgraded = Store.open(path);
    const [environmentId] = upgraded.environments("local");
    const terminalId = newId("term");
    upgraded.append(shellOpened(terminalId, String(environmentId), agentId));
    expect(upgraded.snapshot(testView)).toMatchObject({
      agents: [{ id: agentId, state: "starting" }],
      shells: [{ id: terminalId, state: "creating", cwd: "/work", linkedAgentId: agentId }],
    });
    upgraded.close();
  });

  it("upgrades a schema-14 database, its shells unnamed until they are named", () => {
    const path = dbPath();
    const v14 = Store.open(path, MIGRATIONS.slice(0, 14));
    const environmentId = withEnvironment(v14);
    const terminalId = newId("term");
    v14.append(shellOpened(terminalId, environmentId, null));
    v14.close();
    const upgraded = Store.open(path);
    const before = upgraded.snapshot(testView).shells[0]?.name;
    upgraded.append({
      type: "terminal.renamed",
      entityId: terminalId,
      actor: "user",
      payload: { name: "logs" },
    });
    expect([before, upgraded.snapshot(testView).shells[0]?.name]).toEqual([null, "logs"]);
    upgraded.close();
  });

  it("upgrades a schema-21 database, and a device paired after it opens a notice", () => {
    const path = dbPath();
    Store.open(path, MIGRATIONS.slice(0, 21)).close();
    const upgraded = Store.open(path);
    const device = upgraded.pairDevice("phone", "hash", true, new Date(), loopbackPairing);
    expect(upgraded.snapshot(testView).notices.map((n) => n.device?.id)).toEqual([device]);
    upgraded.close();
  });

  it("upgrades a schema-17 database, its shells running nothing until one is seen to", () => {
    const path = dbPath();
    const v17 = Store.open(path, MIGRATIONS.slice(0, 17));
    const environmentId = withEnvironment(v17);
    const terminalId = newId("term");
    v17.append(shellOpened(terminalId, environmentId, null));
    v17.close();
    const upgraded = Store.open(path);
    const before = upgraded.snapshot(testView).shells[0]?.foreground;
    upgraded.append({
      type: "terminal.foreground_changed",
      entityId: terminalId,
      actor: "system",
      payload: { command: "make" },
    });
    upgraded.noteShellCwd(terminalId, "/work/sub");
    expect([before, upgraded.snapshot(testView).shells[0]?.foreground?.command]).toEqual([
      null,
      "make",
    ]);
    expect(upgraded.shell(terminalId)?.currentCwd).toBe("/work/sub");
    upgraded.close();
  });

  it("upgrades a database from the schema before 28, its terminals needing no restart", () => {
    const path = dbPath();
    const old = Store.open(path, MIGRATIONS.slice(0, 27));
    const { agentId, terminalId } = launch(old, withEnvironment(old));
    old.append(running(agentId));
    old.close();
    const upgraded = Store.open(path);
    expect([
      upgraded.snapshot(testView).agents[0]?.needsRestart,
      upgraded.restartUnrecorded(terminalId),
      upgraded.restartsRecorded(),
    ]).toEqual([null, true, []]);
    upgraded.close();
  });

  it("upgrades a database from the schema before 27, every terminal it had made on tmux", () => {
    const path = dbPath();
    const old = Store.open(path, MIGRATIONS.slice(0, 26));
    const { agentId } = launch(old, withEnvironment(old));
    const shellId = runningShell(old);
    old.close();
    const upgraded = Store.open(path);
    expect([
      upgraded.agentTerminal({ agentId })?.runtimeKind,
      upgraded.shell(shellId)?.runtimeKind,
    ]).toEqual(["tmux", "tmux"]);
    upgraded.close();
  });

  it("keeps the runtime a terminal was requested on from creating, through running, to lost", () => {
    const store = Store.open(dbPath());
    const environmentId = withEnvironment(store);
    const agentId = newId("agent");
    store.append({
      type: "agent.launched",
      entityId: agentId,
      actor: "system",
      payload: {
        environmentId,
        harness: "claude-code",
        project: "p",
        cwd: "/work",
        terminalId: newId("term"),
        runtime: "holder",
      },
    });
    const shellId = newId("term");
    store.append({
      ...shellOpened(shellId, environmentId, null),
      payload: { ...shellOpened(shellId, environmentId, null).payload, runtime: "holder" },
    });
    const kinds = () => [
      store.agentTerminal({ agentId })?.runtimeKind,
      store.shell(shellId)?.runtimeKind,
    ];
    const creating = [...kinds(), store.agentTerminal({ agentId })?.runtime];
    const ref = { runtime: "holder", locator: { generation: "0" } };
    store.append({ ...running(agentId), payload: { externalRef: null, runtimeRef: ref } });
    store.append({
      type: "terminal.running",
      entityId: shellId,
      actor: "system",
      payload: { runtimeRef: ref },
    });
    const confirmed = kinds();
    store.append({ type: "agent.lost", entityId: agentId, actor: "system", payload: {} });
    store.append(shellEvent(shellId, "terminal.lost"));
    expect([creating, confirmed, kinds()]).toEqual([
      ["holder", "holder", null],
      ["holder", "holder"],
      ["holder", "holder"],
    ]);
    store.close();
  });

  it("moves a shell through its own events, and never an agent's terminal by them", () => {
    const store = Store.open(dbPath());
    const environmentId = withEnvironment(store);
    const { terminalId: agentTerminal } = launch(store, environmentId);
    const terminalId = newId("term");
    store.append(shellOpened(terminalId, environmentId, null));
    const event = (type: "terminal.closing" | "terminal.lost", id = terminalId) =>
      ({ type, entityId: id, actor: "system", payload: {} }) as const;
    store.append({
      type: "terminal.running",
      entityId: terminalId,
      actor: "system",
      payload: { runtimeRef: { runtime: "tmux", locator: { generation: "0" } } },
    });
    store.append(event("terminal.lost"));
    expect(store.shell(terminalId)).toMatchObject({ state: "lost", generation: 0 });
    expect(() => store.append(event("terminal.closing", agentTerminal))).toThrow(UnknownEntity);
    expect(store.terminalState(agentTerminal)).toBe("creating");
    store.close();
  });

  it("records no event when its projection refuses it", () => {
    const store = Store.open(dbPath());
    launch(store, withEnvironment(store));
    const before = store.snapshot(testView).eventId;
    expect(() => store.append(running(newId("agent")))).toThrow(UnknownEntity);
    expect(store.snapshot(testView).eventId).toBe(before);
    store.close();
  });

  it("moves a launched agent's terminal to running, and the agent once its harness is up, each once", () => {
    const path = dbPath();
    const store = Store.open(path);
    const { agentId, terminalId } = launch(store, withEnvironment(store));
    expect(store.snapshot(testView).agents).toMatchObject([
      { id: agentId, state: "starting", terminalId },
    ]);
    store.append(running(agentId));
    const up = [store.snapshot(testView).agents[0]?.state, store.terminalState(terminalId)];
    expect(() => store.append(running(agentId))).toThrow(InvalidTransition);
    ready(store, agentId);
    expect([up, store.snapshot(testView).agents[0]?.state]).toEqual([
      ["starting", "running"],
      "running",
    ]);
    expect(() => ready(store, agentId)).toThrow(InvalidTransition);
    store.close();
    const raw = new DatabaseSync(path);
    expect(
      raw.prepare("SELECT state, runtime FROM terminals WHERE id = ?").get(terminalId),
    ).toEqual({
      state: "running",
      runtime: "tmux",
    });
    raw.close();
  });

  it("keeps its database and journals readable by this user only, tightening an older one", () => {
    const fresh = dbPath();
    const older = dbPath();
    leftByKilledDaemon(older);
    const store = Store.open(fresh);
    withEnvironment(store);
    const reopened = Store.open(older);
    const files = [fresh, `${fresh}-wal`, `${fresh}-shm`, older, `${older}-wal`, `${older}-shm`];
    expect(files.map((file) => statSync(file).mode & 0o777)).toEqual(files.map(() => 0o600));
    store.close();
    reopened.close();
  });

  it("refuses a database or journal that is a symlink, changing nothing it points at", () => {
    const path = dbPath();
    const elsewhere = join(mkdtempSync(join(tmpdir(), "bz-elsewhere-")), "target");
    writeFileSync(elsewhere, "", { mode: 0o644 });
    symlinkSync(elsewhere, `${path}-wal`);
    expect(() => Store.open(path)).toThrow(UnsafeDatabase);
    symlinkSync(elsewhere, `${path}.db`);
    expect(() => Store.open(`${path}.db`)).toThrow("it is a symlink");
    expect(statSync(elsewhere).mode & 0o777).toBe(0o644);
  });

  it("refuses a FIFO or a directory in a journal's place at once, rather than wait on it", () => {
    const fifo = dbPath();
    execFileSync("mkfifo", [`${fifo}-wal`]);
    const dir = dbPath();
    mkdirSync(`${dir}-shm`);
    expect(() => Store.open(fifo)).toThrow("it is not a regular file");
    expect(() => Store.open(dir)).toThrow("it is not a regular file");
  });

  it("refuses a device as its database, which opens for writing like a file", () => {
    expect(() => Store.open("/dev/null")).toThrow("it is not a regular file");
  });

  it("keeps the same HostId across reopen", () => {
    const path = dbPath();
    const first = Store.open(path);
    const host = first.hostId();
    first.close();
    const again = Store.open(path);
    expect(host).toMatch(/^host_[0-9a-f]{32}$/);
    expect(again.hostId()).toBe(host);
    again.close();
  });

  it("orders events by id for resumable streams", () => {
    const store = Store.open(dbPath());
    const environmentId = withEnvironment(store);
    const a = store.snapshot(testView).eventId;
    launch(store, environmentId);
    expect(store.events(a).map((e) => e.type)).toEqual(["agent.launched"]);
    store.close();
  });

  it("returns the answer a key was first given, across a restart", () => {
    const path = dbPath();
    const store = Store.open(path);
    store.remember("k-1", { agentId: "agent_x", eventIds: [1] });
    store.close();
    const again = Store.open(path);
    expect([again.recall("k-1"), again.recall("k-2")]).toEqual([
      { agentId: "agent_x", eventIds: [1] },
      undefined,
    ]);
    again.close();
  });

  it("rolls a transaction back whole, nested appends included", () => {
    const store = Store.open(dbPath());
    const before = store.snapshot(testView).eventId;
    expect(() =>
      store.transaction(() => {
        withEnvironment(store);
        throw new Error("abandoned");
      }),
    ).toThrow("abandoned");
    expect(store.snapshot(testView)).toMatchObject({ eventId: before, environments: [] });
    store.close();
  });

  it("counts as open every terminal, agent's or shell's, but the lost, closed and failed, and as starting the creating", () => {
    const path = dbPath();
    const store = Store.open(path);
    const environmentId = withEnvironment(store);
    launch(store, environmentId);
    store.append(shellOpened(newId("term"), environmentId, null));
    store.close();
    const counted: Record<string, [number, number]> = {};
    for (const state of TerminalState.options) {
      const raw = new DatabaseSync(path);
      raw.prepare("UPDATE terminals SET state = ?").run(state);
      raw.close();
      const reopened = Store.open(path);
      counted[state] = [reopened.openTerminals(), reopened.startingTerminals()];
      reopened.close();
    }
    expect(counted).toEqual({
      creating: [2, 2],
      running: [2, 0],
      unknown: [2, 0],
      exited: [2, 0],
      closing: [2, 0],
      lost: [0, 0],
      closed: [0, 0],
      failed: [0, 0],
    });
  });

  it("counts the open terminals on each runtime by the runtime each was made on", () => {
    const path = dbPath();
    const store = Store.open(path);
    const environmentId = withEnvironment(store);
    const opened = (runtime: string) => {
      const event = shellOpened(newId("term"), environmentId, null);
      store.append({ ...event, payload: { ...event.payload, runtime } });
      return event.entityId;
    };
    opened("tmux");
    opened("holder");
    const closedOnHolder = opened("holder");
    store.close();
    const raw = new DatabaseSync(path);
    raw.prepare("UPDATE terminals SET state = 'closed' WHERE id = ?").run(closedOnHolder);
    raw.close();
    const reopened = Store.open(path);
    const counted = ["tmux", "holder", "other"].map((k) => reopened.openTerminalsOn(k));
    reopened.close();
    expect(counted).toEqual([1, 1, 0]);
  });
});

/**
 * The `synchronous` level each commit on any connection ran at, in order. With `lockedOnce`, the
 * first write transaction can't begin, as when another writer holds the database past the timeout.
 */
function commitLevels({ lockedOnce = false } = {}): number[] {
  const levels: number[] = [];
  let locked = lockedOnce;
  const { value: exec } = Object.getOwnPropertyDescriptor(DatabaseSync.prototype, "exec") ?? {};
  vi.spyOn(DatabaseSync.prototype, "exec").mockImplementation(function (
    this: DatabaseSync,
    sql: string,
  ) {
    if (sql === "BEGIN IMMEDIATE" && locked) {
      locked = false;
      throw new Error("database is locked");
    }
    if (sql === "COMMIT")
      levels.push(Number(this.prepare("PRAGMA synchronous").get()?.synchronous));
    Reflect.apply(exec, this, [sql]);
  });
  return levels;
}

describe("Store durability", () => {
  afterEach(() => vi.restoreAllMocks());

  it("commits at NORMAL, and a device's revocation, which must not come back after a crash, at FULL", () => {
    const store = Store.open(dbPath());
    const now = new Date("2026-02-01T00:00:00.000Z");
    const levels = commitLevels();
    const device = store.pairDevice("phone", "hash", true, now, loopbackPairing);
    store.revokeDevice(device, now);
    withEnvironment(store);
    expect(levels).toEqual([1, 2, 1]);
    store.close();
  });

  it("goes back to NORMAL when a durable transaction can't even begin", () => {
    const store = Store.open(dbPath());
    const device = store.pairDevice("phone", "hash", true, new Date(), loopbackPairing);
    const levels = commitLevels({ lockedOnce: true });
    expect(() => store.revokeDevice(device, new Date())).toThrow("database is locked");
    withEnvironment(store);
    expect(levels).toEqual([1]);
    store.close();
  });

  it("refuses a durable transaction inside another, whose commit would decide its durability", () => {
    const store = Store.open(dbPath());
    const device = store.pairDevice("phone", "hash", true, new Date(), loopbackPairing);
    expect(() => store.transaction(() => store.revokeDevice(device, new Date()))).toThrow(
      /durable/,
    );
    expect(store.devices().map((d) => d.id)).toEqual([device]);
    store.close();
  });
});

const CUTOFF = new Date("2026-02-01T00:00:00.000Z");

const exited = (agentId: string) => ({
  type: "agent.exited" as const,
  entityId: agentId,
  actor: "system",
  payload: { exit: { type: "exited" as const, code: 0 } },
});

describe("Store snapshot view", () => {
  const view = {
    host: (kind: string) => `${kind}-host`,
    attachCommand: (ref: { locator: Record<string, string> }) => `attach ${ref.locator.session}`,
    resumes: resumesClaude,
    themes: () => ["light", "dark"] as const,
    attentionActions: () => [],
    noticeActions: () => [],
    shellsReport: true,
    listening: () => false,
    promptHash: () => "",
  };

  it("names each environment's host as the view says", () => {
    const store = Store.open(dbPath());
    withEnvironment(store);
    expect(store.snapshot(view).environments).toMatchObject([
      { kind: "local", host: "local-host" },
    ]);
    store.close();
  });

  it("offers an attach command only while the agent's terminal exists in the runtime", () => {
    const store = Store.open(dbPath());
    const { agentId } = launch(store, withEnvironment(store));
    const attach = () => store.snapshot(view).agents[0]?.attachCommand;
    const seen = [attach()];
    store.append(running(agentId));
    seen.push(attach());
    store.append(exited(agentId));
    seen.push(attach());
    store.append({ type: "agent.lost", entityId: agentId, actor: "system", payload: {} });
    seen.push(attach());
    expect(seen).toEqual([null, "attach bz-1", "attach bz-1", null]);
    store.close();
  });

  it("offers respawn only to an exited agent whose session resumes, by the transcript it recorded", () => {
    const store = Store.open(dbPath());
    const environmentId = withEnvironment(store);
    const bare = launch(store, environmentId).agentId;
    const resumable = launch(store, environmentId).agentId;
    store.append(running(bare));
    const ref = { environmentId, kind: "claude-session" as const, id: "s-1" };
    store.append({
      ...running(resumable),
      payload: { ...running(resumable).payload, externalRef: ref },
    });
    store.append(exited(bare));
    store.append(exited(resumable));
    const onTranscript = { ...view, resumes: (a: ResumeEvidence) => a.transcript !== null };
    const commands = () => store.snapshot(onTranscript).agents.map((a) => a.commands);
    const before = commands();
    store.recordTranscript(resumable, "s-1", "/c/s-1.jsonl");
    expect([before, commands()]).toEqual([
      [["close"], ["close"]],
      [["close"], ["close", "respawn"]],
    ]);
    store.close();
  });
});

describe("Store event log", () => {
  it("gives each database its own epoch, kept across reopen and carried by the snapshot", () => {
    const path = dbPath();
    const first = Store.open(path);
    const epoch = first.epoch();
    first.close();
    const again = Store.open(path);
    const other = Store.open(dbPath());
    expect(epoch).toMatch(/^[0-9a-f]{32}$/);
    expect([again.epoch(), again.snapshot(testView).epoch]).toEqual([epoch, epoch]);
    expect(other.epoch()).not.toBe(epoch);
    again.close();
    other.close();
  });

  it("mints an epoch for a database upgraded from schema 5, resumable from its newest event", () => {
    const path = dbPath();
    const v5 = Store.open(path, MIGRATIONS.slice(0, 5));
    withEnvironment(v5);
    v5.close();
    const upgraded = Store.open(path);
    const { epoch, eventId } = upgraded.snapshot(testView);
    expect([epoch, upgraded.cursorFault(epoch, eventId)]).toEqual([
      expect.stringMatching(/^[0-9a-f]{32}$/),
      null,
    ]);
    upgraded.close();
  });

  it("reads every attention item of a schema-13 database as an approval once upgraded", () => {
    const path = dbPath();
    const v13 = Store.open(path, MIGRATIONS.slice(0, 13));
    const { agentId } = launch(v13, withEnvironment(v13));
    v13.close();
    const id = newId("attn");
    const raw = new DatabaseSync(path);
    raw.exec(`INSERT INTO attention_items VALUES ('${id}', '${agentId}', 'open', NULL, 'Bash',
              NULL, 1, 1, 1)`);
    raw.close();
    const upgraded = Store.open(path);
    expect(upgraded.openAttention()).toMatchObject([{ id, kind: "approval" }]);
    upgraded.close();
  });

  it("reads back each event whole, payload included", () => {
    const store = Store.open(dbPath());
    const environmentId = withEnvironment(store);
    expect(store.events(0)).toEqual([
      {
        id: 1,
        ts: expect.any(String),
        type: "environment.registered",
        entityType: "environment",
        entityId: environmentId,
        actor: "system",
        causationId: null,
        correlationId: null,
        payload: { kind: "local" },
      },
    ]);
    store.close();
  });

  it("tells listeners once per transaction that appended, never about a rolled-back one", async () => {
    const store = Store.open(dbPath());
    let calls = 0;
    store.onCommit(() => calls++);
    store.transaction(() => {
      launch(store, withEnvironment(store));
    });
    await settled();
    expect(calls).toBe(1);
    expect(() =>
      store.transaction(() => {
        withEnvironment(store);
        throw new Error("abandoned");
      }),
    ).toThrow("abandoned");
    store.transaction(() => store.remember("k-1", {}));
    await settled();
    expect(calls).toBe(1);
    store.close();
  });

  it("keeps a committed append when a listener throws, and still tells the others", async () => {
    const store = Store.open(dbPath());
    let told = false;
    store.onCommit(() => {
      throw new Error("broken subscriber");
    });
    store.onCommit(() => (told = true));
    withEnvironment(store);
    await settled();
    expect([told, store.snapshot(testView).environments.length]).toEqual([true, 1]);
    store.close();
  });

  it("retires old events no projection points at, and keeps those one does", async () => {
    const { path, store, agentId, terminalId } = await withAgent();
    // Never offered, so its first_offered_event_id is NULL: retention must still prune.
    store.append({
      type: "mailbox.queued",
      entityId: newId("msg"),
      actor: "system",
      payload: { agentId, body: "hi" },
    });
    const kept = store.events(0).map((e) => e.type);
    const [, ended] = visit(store, terminalId);
    age(path);
    const [young] = visit(store, terminalId);
    expect(store.pruneBatch(CUTOFF)).toBe(false);
    expect(store.events(0).map((e) => e.type)).toEqual([
      ...kept,
      "attachment.started",
      "attachment.ended",
    ]);
    expect(store.events(0).at(-2)?.id).toBe(young);
    const epoch = store.epoch();
    expect([store.cursorFault(epoch, ended - 1), store.cursorFault(epoch, ended)]).toEqual([
      "stale",
      null,
    ]);
    store.close();
  });

  it("never retires the newest event, so later ids stay above what retention has passed", async () => {
    const { path, store, terminalId } = await withAgent();
    const [, newest] = visit(store, terminalId);
    age(path);
    store.pruneBatch(new Date("2100-01-01T00:00:00.000Z"));
    expect(store.events(newest - 1).map((e) => e.id)).toEqual([newest]);
    const [next] = visit(store, terminalId);
    expect(next).toBe(newest + 1);
    expect(store.cursorFault(store.epoch(), newest)).toBeNull();
    store.close();
  });

  it("retires a long backlog in bounded batches, each moving the watermark up", async () => {
    const { path, store, terminalId } = await withAgent();
    const [, firstEnd] = visit(store, terminalId);
    visit(store, terminalId);
    const [, newest] = visit(store, terminalId);
    age(path);
    const epoch = store.epoch();
    // Ten events, two per batch: the first visit's end (id 6) falls behind in the fourth.
    const faults: (string | null)[] = [];
    while (store.pruneBatch(CUTOFF, 2)) faults.push(store.cursorFault(epoch, firstEnd));
    expect(faults).toEqual([null, null, null, "stale", "stale"]);
    expect(store.cursorFault(epoch, newest)).toBeNull();
    store.close();
  });

  it("calls a cursor foreign when it names another store or an event this one never had", () => {
    const store = Store.open(dbPath());
    withEnvironment(store);
    const { epoch, eventId } = store.snapshot(testView);
    expect([
      store.cursorFault("0".repeat(32), eventId),
      store.cursorFault(epoch, eventId + 1),
      store.cursorFault(epoch, eventId),
      store.cursorFault(epoch, 0),
    ]).toEqual(["foreign", "foreign", null, null]);
    store.close();
  });

  it("retires an old event once the projection that kept it no longer points at it", async () => {
    const { path, store, terminalId } = await withAgent();
    const attachmentId = newId("att");
    const started = store.append({
      type: "attachment.started",
      entityId: attachmentId,
      actor: "system",
      payload: { terminalId, mode: "observe" },
    });
    age(path);
    store.pruneBatch(CUTOFF);
    const keptWhileOpen = store.events(started - 1, 1).map((e) => e.id);
    store.append({
      type: "attachment.ended",
      entityId: attachmentId,
      actor: "system",
      payload: { reason: "client_closed" },
    });
    store.pruneBatch(CUTOFF);
    const keptAfterEnd = store.events(0).some((e) => e.id === started);
    expect([keptWhileOpen, keptAfterEnd]).toEqual([[started], false]);
    store.close();
  });
});

const activity = (
  value: "working" | "idle",
  observedAt: string,
  more: { detail?: string; confidence?: number } = {},
) => ({ value, source: "native" as const, confidence: more.confidence ?? 1, observedAt, ...more });

const limited = (observedAt: string, resetsAt: string) => ({
  ...activity("working", observedAt, { detail: "rate_limit" }),
  value: "limited" as const,
  resetsAt,
});

const activityEvents = (store: Store) => store.events(0).filter((e) => e.type === "agent.activity");

describe("Store activity signals", () => {
  it("keeps the latest signal per agent, and shows it with the agent in the snapshot", async () => {
    const { store, agentId } = await withAgent();
    expect(store.snapshot(testView).agents[0]).not.toHaveProperty("activity");
    store.recordActivity(agentId, activity("working", "2026-11-12T10:00:00.000Z"));
    store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:05.000Z"));
    expect(store.latestActivity(agentId)?.value).toBe("idle");
    expect(store.snapshot(testView).agents[0]?.activity).toEqual(
      activity("idle", "2026-11-12T10:00:05.000Z"),
    );
  });

  it("appends nothing for a repeat, whenever it was seen and however sure", async () => {
    const { store, agentId } = await withAgent();
    const first = store.recordActivity(agentId, activity("working", "2026-11-12T10:00:00.000Z"));
    const again = store.recordActivity(
      agentId,
      activity("working", "2026-11-12T10:00:09.000Z", { confidence: 0.5 }),
    );
    // The first of the repeats stands, so its age shows how long the agent has been working.
    expect(store.latestActivity(agentId)?.observedAt).toBe("2026-11-12T10:00:00.000Z");
    const changed = store.recordActivity(
      agentId,
      activity("working", "2026-11-12T10:00:10.000Z", { detail: "auto-continued" }),
    );
    expect(first).toBeTypeOf("number");
    expect(again).toBeNull();
    expect(changed).toBeTypeOf("number");
    expect(activityEvents(store)).toHaveLength(2);
  });

  it("records a limited signal again when the time its limit resets changes", async () => {
    const { store, agentId } = await withAgent();
    const first = store.recordActivity(
      agentId,
      limited("2026-11-12T10:00:00.000Z", "2026-11-12T15:00:00.000Z"),
    );
    const later = store.recordActivity(
      agentId,
      limited("2026-11-12T10:00:05.000Z", "2026-11-18T15:00:00.000Z"),
    );
    expect([first === null, later === null]).toEqual([false, false]);
    expect(store.latestActivity(agentId)?.resetsAt).toBe("2026-11-18T15:00:00.000Z");
  });

  it("drops a signal observed before the latest, which arrived late", async () => {
    const { store, agentId } = await withAgent();
    store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:05.000Z"));
    expect(
      store.recordActivity(agentId, activity("working", "2026-11-12T10:00:00.000Z")),
    ).toBeNull();
    expect(store.latestActivity(agentId)?.value).toBe("idle");
    expect(activityEvents(store)).toHaveLength(1);
  });

  it("refuses a signal for an agent it doesn't run, recording nothing", async () => {
    const { store } = await withAgent();
    expect(() =>
      store.recordActivity(newId("agent"), activity("idle", "2026-11-12T10:00:00.000Z")),
    ).toThrow(UnknownAgent);
    expect(activityEvents(store)).toHaveLength(0);
  });

  it("records nothing for an agent whose process has exited", async () => {
    const { store, agentId } = await withAgent();
    store.append({
      type: "agent.exited",
      entityId: agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 0 } },
    });
    expect(store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:00.000Z"))).toBeNull();
    expect(activityEvents(store)).toHaveLength(0);
  });

  it("forgets the old process's signal when the agent is respawned", async () => {
    const { store, agentId } = await withAgent();
    store.recordActivity(agentId, activity("working", "2026-11-12T10:00:00.000Z"));
    store.append({
      type: "agent.exited",
      entityId: agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 0 } },
    });
    store.append({
      type: "agent.respawn_requested",
      entityId: agentId,
      actor: "system",
      payload: {},
    });
    store.append({
      type: "agent.respawned",
      entityId: agentId,
      actor: "system",
      payload: { externalRef: null, runtimeRef: { runtime: "tmux", locator: { generation: "1" } } },
    });
    expect(store.latestActivity(agentId)).toBeUndefined();
    // The new process's first signal is news, not a repeat of the old process's.
    expect(
      store.recordActivity(agentId, activity("working", "2026-11-12T10:01:00.000Z")),
    ).toBeTypeOf("number");
  });

  it("forgets an agent's signal once it is closed", async () => {
    const { store, agentId } = await withAgent();
    store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:00.000Z"));
    store.append({ type: "agent.closing", entityId: agentId, actor: "system", payload: {} });
    store.append({ type: "agent.closed", entityId: agentId, actor: "system", payload: {} });
    expect(store.latestActivity(agentId)).toBeUndefined();
    expect(store.snapshot(testView).agents[0]).not.toHaveProperty("activity");
  });

  it("keeps the latest signal across reopen", async () => {
    const { path, store, agentId } = await withAgent();
    store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:00.000Z"));
    store.close();
    expect(Store.open(path).latestActivity(agentId)?.value).toBe("idle");
  });

  it("never retires the event behind an agent's latest signal", async () => {
    const { path, store, agentId, terminalId } = await withAgent();
    const kept = store.recordActivity(agentId, activity("idle", "2026-11-12T10:00:00.000Z"));
    // Retention always keeps the newest event, so a later one makes the signal's prunable.
    visit(store, terminalId);
    store.close();
    age(path);
    const reopened = Store.open(path);
    reopened.pruneBatch(new Date());
    expect(reopened.events(0).map((e) => e.id)).toContain(kept);
    expect(reopened.latestActivity(agentId)?.value).toBe("idle");
  });
});

describe("Store usage", () => {
  it("keeps the model and context use its harness last reported, recording only a change", async () => {
    const { store, agentId } = await withAgent();
    const usage = { model: "Opus 5.5", contextUsedPercent: 3, contextWindowTokens: 1_000_000 };
    expect(store.snapshot(testView).agents[0]).not.toHaveProperty("usage");
    const first = store.recordUsage(agentId, usage);
    const again = store.recordUsage(agentId, { ...usage });
    const grown = store.recordUsage(agentId, { ...usage, contextUsedPercent: 4 });
    expect([first, again, grown].map((id) => id === null)).toEqual([false, true, false]);
    expect(store.snapshot(testView).agents[0]?.usage).toEqual({ ...usage, contextUsedPercent: 4 });
  });

  it("reads back the usage its harness last reported, and none before it reports any", async () => {
    const { store, agentId } = await withAgent();
    const before = store.usage(agentId);
    const limits = [
      { window: "five_hour", usedPercent: 100, resetsAt: "2026-11-18T13:00:00.000Z" },
    ];
    store.recordUsage(agentId, { model: "Opus" });
    store.recordUsage(agentId, { model: "Opus", limits });
    expect([before, store.usage(agentId), store.usage(newId("agent"))]).toEqual([
      undefined,
      { model: "Opus", limits },
      undefined,
    ]);
  });

  it("records no usage for an agent whose process has exited, and refuses one it never ran", async () => {
    const { store, agentId } = await withAgent();
    store.append({
      type: "agent.exited",
      entityId: agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 0 } },
    });
    expect(store.recordUsage(agentId, { model: "Opus" })).toBeNull();
    expect(() => store.recordUsage(newId("agent"), { model: "Opus" })).toThrow(UnknownAgent);
  });

  it("records a compaction with the usage last recorded before it, or none", async () => {
    const { store, agentId } = await withAgent();
    const compactions = () =>
      store
        .events(0)
        .filter((e) => e.type === "agent.compacted")
        .map((e) => e.payload);
    store.recordCompaction(agentId, "codex_item");
    store.recordUsage(agentId, { model: "Opus", contextUsedPercent: 88 });
    store.recordCompaction(agentId, "claude_hook");
    expect(compactions()).toEqual([
      { sign: "codex_item" },
      { sign: "claude_hook", before: { model: "Opus", contextUsedPercent: 88 } },
    ]);
  });

  it("records each hook's compaction once when two hooks report theirs again, the later first", async () => {
    const { store, agentId } = await withAgent();
    const recorded = [hook(41), hook(42), hook(42), hook(41)].map(
      (h) => store.recordCompaction(agentId, "claude_hook", h) !== null,
    );
    const noSession = { sessionId: null, pid: 43 };
    recorded.push(
      store.recordCompaction(agentId, "claude_hook", noSession) !== null,
      store.recordCompaction(agentId, "claude_hook", noSession) !== null,
    );
    expect(recorded).toEqual([true, true, false, false, true, false]);
  });

  it("records a hook's compaction once, however often the same hook reports it", async () => {
    const { store, agentId } = await withAgent();
    const recorded = [
      store.recordCompaction(agentId, "claude_hook", hook(41)),
      store.recordCompaction(agentId, "claude_hook", hook(41)),
      store.recordCompaction(agentId, "claude_hook", hook(42)),
      store.recordCompaction(agentId, "claude_hook", { sessionId: "s-2", pid: 42 }),
    ];
    expect(recorded.map((id) => id !== null)).toEqual([true, false, true, true]);
  });

  it("records no compaction for an agent whose process has exited, and refuses one it never ran", async () => {
    const { store, agentId } = await withAgent();
    store.append({
      type: "agent.exited",
      entityId: agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 0 } },
    });
    expect(store.recordCompaction(agentId, "claude_hook")).toBeNull();
    expect(() => store.recordCompaction(newId("agent"), "claude_hook")).toThrow(UnknownAgent);
  });

  it("forgets an agent's usage when its process is replaced or it is closed", async () => {
    const respawned = await withAgent();
    respawned.store.recordUsage(respawned.agentId, { model: "Opus" });
    respawned.store.append({
      type: "agent.exited",
      entityId: respawned.agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 0 } },
    });
    respawned.store.append({
      type: "agent.respawn_requested",
      entityId: respawned.agentId,
      actor: "system",
      payload: {},
    });
    respawned.store.append({
      type: "agent.respawned",
      entityId: respawned.agentId,
      actor: "system",
      payload: { externalRef: null, runtimeRef: { runtime: "tmux", locator: { generation: "1" } } },
    });
    const closed = await withAgent();
    closed.store.recordUsage(closed.agentId, { model: "Opus" });
    closed.store.append({
      type: "agent.closing",
      entityId: closed.agentId,
      actor: "system",
      payload: {},
    });
    closed.store.append({
      type: "agent.closed",
      entityId: closed.agentId,
      actor: "system",
      payload: {},
    });
    expect([
      respawned.store.snapshot(testView).agents[0],
      closed.store.snapshot(testView).agents[0],
    ]).toEqual([
      expect.not.objectContaining({ usage: expect.anything() }),
      expect.not.objectContaining({ usage: expect.anything() }),
    ]);
  });
});

const event = (agentId: string) => ({ entityId: agentId, actor: "user" });

/** A launched agent whose terminal was lost, on a Claude Code session. */
function lostAgent(store: Store) {
  const environmentId = withEnvironment(store);
  const { agentId, terminalId } = launch(store, environmentId);
  const ref = { environmentId, kind: "claude-session" as const, id: "s-1" };
  store.append({
    ...running(agentId),
    payload: { ...running(agentId).payload, externalRef: ref },
  });
  store.recordUsage(agentId, { model: "Opus" });
  store.append({ ...event(agentId), type: "agent.lost", payload: {} });
  return { agentId, lostTerminal: terminalId, session: ref };
}

const requested = (agentId: string, terminalId: string) => ({
  ...event(agentId),
  type: "agent.relaunch_requested" as const,
  payload: { terminalId, generation: 1, fresh: false },
});

describe("Store reads read every second", () => {
  it("finds an agent by its terminal through primary keys, never a scan of every agent", () => {
    const path = dbPath();
    Store.open(path).close();
    const raw = new DatabaseSync(path);
    const plan = raw
      .prepare(`EXPLAIN QUERY PLAN ${AGENT_BY_TERMINAL}`)
      .all("term_x")
      .map((step) => String(step.detail));
    raw.close();
    expect(plan.filter((detail) => !detail.startsWith("SEARCH"))).toEqual([]);
  });
});

describe("Store relaunch", () => {
  it("moves a relaunched agent to a new terminal at the next generation, leaving the lost one lost", () => {
    const store = Store.open(dbPath());
    const { agentId, lostTerminal } = lostAgent(store);
    const terminalId = newId("term");
    store.append(requested(agentId, terminalId));
    store.append({
      ...event(agentId),
      type: "agent.relaunched",
      payload: { externalRef: null, runtimeRef: { runtime: "tmux", locator: { session: "bz-2" } } },
    });
    const agent = store.snapshot(testView).agents[0];
    expect([
      agent?.state,
      agent?.terminalId,
      agent?.generation,
      agent?.usage,
      store.terminalState(lostTerminal),
      store.agentTerminal({ terminalId })?.agentId,
      store.agentTerminal({ terminalId: lostTerminal }),
    ]).toEqual(["starting", terminalId, 1, undefined, "lost", agentId, undefined]);
    store.close();
  });

  it("relaunches onto the runtime the request names, leaving the lost terminal on its own", () => {
    const path = dbPath();
    const store = Store.open(path);
    const { agentId, lostTerminal } = lostAgent(store);
    const terminalId = newId("term");
    const request = requested(agentId, terminalId);
    store.append({ ...request, payload: { ...request.payload, runtime: "holder" } });
    const relaunched = store.agentTerminal({ agentId })?.runtimeKind;
    store.close();
    const raw = new DatabaseSync(path);
    const lost = raw.prepare("SELECT runtime_kind FROM terminals WHERE id = ?").get(lostTerminal);
    raw.close();
    expect([relaunched, lost?.runtime_kind]).toEqual(["holder", "tmux"]);
  });

  it("returns a rejected relaunch to the terminal it was lost on, which close still ends", () => {
    const store = Store.open(dbPath());
    const { agentId, lostTerminal } = lostAgent(store);
    const terminalId = newId("term");
    store.append(requested(agentId, terminalId));
    store.append({
      ...event(agentId),
      type: "agent.relaunch_rejected",
      payload: { reason: "unavailable" },
    });
    const rejected = store.snapshot(testView).agents[0];
    store.append({ ...event(agentId), type: "agent.closing", payload: {} });
    store.append({ ...event(agentId), type: "agent.closed", payload: {} });
    expect([
      rejected?.state,
      rejected?.terminalId,
      store.terminalState(terminalId),
      store.terminalState(lostTerminal),
    ]).toEqual(["lost", lostTerminal, "failed", "closed"]);
    store.close();
  });

  it("keeps the transcript across a relaunch on the same session, and forgets it on a fresh one", () => {
    const store = Store.open(dbPath());
    const { agentId, session } = lostAgent(store);
    store.recordTranscript(agentId, "s-1", "/c/s-1.jsonl");
    const relaunch = (externalRef: ExternalRef | null) => {
      store.append(requested(agentId, newId("term")));
      store.append({
        ...event(agentId),
        type: "agent.relaunched",
        payload: { externalRef, runtimeRef: { runtime: "tmux", locator: { session: "bz-2" } } },
      });
      const kept = store.agentLaunch(agentId)?.transcript;
      store.append({ ...event(agentId), type: "agent.lost", payload: {} });
      return kept;
    };
    const resumed = relaunch(session);
    const fresh = relaunch({ ...session, id: "s-2" });
    expect([resumed, fresh]).toEqual(["/c/s-1.jsonl", null]);
    store.close();
  });

  it("takes a transcript only for the session the agent is bound to", () => {
    const store = Store.open(dbPath());
    const { agentId } = lostAgent(store);
    const record = (sessionId: string, path: string) =>
      store.append({
        ...event(agentId),
        type: "agent.transcript_recorded",
        payload: { sessionId, path },
      });
    record("s-1", "/c/s-1.jsonl");
    record("s-old", "/c/s-old.jsonl");
    expect(store.agentLaunch(agentId)?.transcript).toBe("/c/s-1.jsonl");
    store.close();
  });

  it("refuses a rejected relaunch for an agent never lost, which a launch's start can't take", () => {
    const store = Store.open(dbPath());
    const { agentId } = launch(store, withEnvironment(store));
    expect(() =>
      store.append({
        ...event(agentId),
        type: "agent.relaunch_rejected",
        payload: { reason: "unavailable" },
      }),
    ).toThrow(UnknownEntity);
    expect(store.agentTerminal({ agentId })?.state).toBe("starting");
    store.close();
  });

  it("offers relaunch to a lost agent, saying whether it would resume its session", () => {
    const store = Store.open(dbPath());
    lostAgent(store);
    const offered = (resumes: boolean) => {
      const a = store.snapshot({ ...testView, resumes: () => resumes }).agents[0];
      return [a?.commands, a?.resumable];
    };
    expect([offered(true), offered(false)]).toEqual([
      [["close", "relaunch"], true],
      [["close", "relaunch"], false],
    ]);
    store.close();
  });

  describe("a shell's last command", () => {
    it("upgrades a schema-22 database, its shells keeping no command until one is reported", () => {
      const path = dbPath();
      const v22 = Store.open(path, MIGRATIONS.slice(0, 22));
      const terminalId = runningShell(v22);
      v22.close();
      const upgraded = Store.open(path);
      const before = upgraded.lastShellCommand(terminalId);
      upgraded.noteShellCommand(terminalId, 1, "make");
      expect([before, upgraded.lastShellCommand(terminalId)]).toEqual([null, "make"]);
      upgraded.close();
    });

    it("keeps the newest line a live shell reported, so a late older report changes nothing", () => {
      const store = Store.open(dbPath());
      const terminalId = runningShell(store);
      const counted = [
        store.noteShellCommand(terminalId, 2, "moon run :dev"),
        store.noteShellCommand(terminalId, 1, "ls"),
        store.noteShellCommand(terminalId, 2, "ls"),
      ];
      expect([counted, store.lastShellCommand(terminalId)]).toEqual([
        [true, false, false],
        "moon run :dev",
      ]);
      store.close();
    });

    it("clears the kept line when a newer one can't be typed back, rather than keep the older", () => {
      const store = Store.open(dbPath());
      const terminalId = runningShell(store);
      store.noteShellCommand(terminalId, 1, "moon run :dev");
      store.noteShellCommand(terminalId, 2, "make\nrm -rf ~");
      const afterNewline = store.lastShellCommand(terminalId);
      store.noteShellCommand(terminalId, 3, "moon run :dev");
      store.noteShellCommand(terminalId, 4, null);
      expect([afterNewline, store.lastShellCommand(terminalId)]).toEqual([null, null]);
      store.close();
    });

    it("keeps a lost shell's line for its restart, and takes no report for it", () => {
      const store = Store.open(dbPath());
      const terminalId = runningShell(store);
      store.noteShellCommand(terminalId, 1, "cargo watch");
      store.append(shellEvent(terminalId, "terminal.lost"));
      const counted = store.noteShellCommand(terminalId, 2, "ls");
      expect([counted, store.lastShellCommand(terminalId)]).toEqual([false, "cargo watch"]);
      store.close();
    });

    it("forgets the line once the shell closes or fails, and never writes it into an event", () => {
      const path = dbPath();
      const store = Store.open(path);
      const closed = runningShell(store);
      const failed = newId("term");
      store.append(shellOpened(failed, withEnvironment(store), null));
      store.noteShellCommand(closed, 1, "export TOKEN=s3cret-closed");
      store.noteShellCommand(failed, 1, "export TOKEN=s3cret-failed");
      store.append(shellEvent(closed, "terminal.closing"));
      store.append({
        type: "terminal.closed",
        entityId: closed,
        actor: "user",
        payload: { reason: "user" },
      });
      store.append({
        type: "terminal.failed",
        entityId: failed,
        actor: "system",
        payload: { reason: "open_rejected" },
      });
      expect([store.lastShellCommand(closed), store.lastShellCommand(failed)]).toEqual([
        null,
        null,
      ]);
      store.close();
      const raw = new DatabaseSync(path);
      const events = raw.prepare("SELECT count(*) AS n FROM events WHERE payload LIKE '%s3cret%'");
      expect(events.get()?.n).toBe(0);
      raw.close();
    });

    it("leaves no trace of a closed shell's line in the database or its journal", () => {
      const path = dbPath();
      const store = Store.open(path);
      // Rows after it on the same page keep a cleared row's old bytes where they stood, unzeroed.
      const terminalId = runningShell(store);
      runningShell(store);
      runningShell(store);
      store.noteShellCommand(terminalId, 1, "export TOKEN=s3cret-on-disk");
      store.append(shellEvent(terminalId, "terminal.closing"));
      store.append({
        type: "terminal.closed",
        entityId: terminalId,
        actor: "user",
        payload: { reason: "user" },
      });
      const traces = [path, `${path}-wal`].map((file) => readFileSync(file).includes("s3cret"));
      store.close();
      expect(traces).toEqual([false, false]);
    });
  });
});

function named(store: Store, project: string, name?: string, nameOrdinal?: number) {
  const agentId = newId("agent");
  store.append({
    type: "agent.launched",
    entityId: agentId,
    actor: "system",
    payload: {
      environmentId: withEnvironment(store),
      harness: "claude-code",
      project,
      cwd: "/work",
      terminalId: null,
      ...(name === undefined ? {} : { name }),
      ...(nameOrdinal === undefined ? {} : { nameOrdinal }),
    },
  });
  return agentId;
}
const fail = (store: Store, agentId: string) =>
  store.append({
    type: "agent.failed",
    entityId: agentId,
    actor: "system",
    payload: { reason: "launch_rejected" },
  });
const names = (store: Store) => store.snapshot(testView).agents.map((a) => a.name);

describe("agent names", () => {
  it("upgrades a schema-23 database, naming every agent by its project in launch order", () => {
    const path = dbPath();
    const v23 = Store.open(path, MIGRATIONS.slice(0, 23));
    named(v23, "p");
    fail(v23, named(v23, "p"));
    named(v23, "my.app");
    v23.close();
    const upgraded = Store.open(path);
    expect([...names(upgraded), upgraded.nextDefaultName("p").name]).toEqual([
      "p-1",
      "p-2",
      "my-app-1",
      "p-3",
    ]);
    upgraded.close();
  });

  it("upgrades a schema-24 database, its running agents answering to no name until restarted", () => {
    const path = dbPath();
    const v24 = Store.open(path, MIGRATIONS.slice(0, 24));
    const from = named(v24, "p", "BZ-1");
    const to = named(v24, "p", "BZ-127");
    v24.append({
      type: "agent.running",
      entityId: to,
      actor: "system",
      payload: { externalRef: null, runtimeRef: null },
    });
    v24.close();
    const upgraded = Store.open(path);
    upgraded.append({
      type: "message.observed",
      entityId: newId("obs"),
      actor: from,
      payload: { from, to, summary: "hi", text: "hi", accepted: true, toolUseId: "t-1" },
    });
    expect([
      upgraded.agentsStartedAs("BZ-127"),
      upgraded.snapshot(testView).observed.map((m) => [m.from, m.to]),
    ]).toEqual([[], [[from, to]]]);
    upgraded.close();
  });

  it("upgrades projects that make one base onto one counter, each keeping its own spelling", () => {
    const path = dbPath();
    const v23 = Store.open(path, MIGRATIONS.slice(0, 23));
    for (const project of ["Bazhen", "bazhen", "my.app", "my app", ".agent_tools"])
      named(v23, project);
    v23.close();
    const upgraded = Store.open(path);
    expect([...names(upgraded), upgraded.nextDefaultName("BAZHEN").name]).toEqual([
      "Bazhen-1",
      "bazhen-2",
      "my-app-1",
      "my-app-2",
      "agent_tools-1",
      "BAZHEN-3",
    ]);
    upgraded.close();
  });

  it("resolves an exact id in any state, and a name only among agents not ended", () => {
    const store = Store.open(dbPath());
    const live = named(store, "p", "BZ-127");
    const ended = named(store, "p", "old");
    fail(store, ended);
    const resolved = [store.resolveAgent(ended), store.resolveAgent("bz-127")];
    expect(resolved).toEqual([ended, live]);
    expect(() => store.resolveAgent("old")).toThrow(UnknownAgent);
    store.close();
  });

  it("never resolves part of a name", () => {
    const store = Store.open(dbPath());
    named(store, "p", "coordinator-1");
    expect(() => store.resolveAgent("coordinator")).toThrow(UnknownAgent);
    store.close();
  });

  it("gives a default name no live agent holds, and never a number given before", () => {
    const store = Store.open(dbPath());
    fail(store, named(store, "p", "p-1", 1));
    named(store, "p", "P-2");
    expect(store.nextDefaultName("p")).toEqual({ name: "p-3", ordinal: 3 });
    store.close();
  });

  it("lets a freed name be taken again, and refuses a second live holder past every check", () => {
    const store = Store.open(dbPath());
    fail(store, named(store, "p", "lead"));
    named(store, "p", "lead");
    expect(() => named(store, "p", "LEAD")).toThrow(/UNIQUE/);
    store.close();
  });

  it("shows a rename in the snapshot", () => {
    const store = Store.open(dbPath());
    const agentId = named(store, "p", "p-1", 1);
    store.append({
      type: "agent.renamed",
      entityId: agentId,
      actor: "user",
      payload: { name: "reviewer", previous: "p-1" },
    });
    expect(names(store)).toEqual(["reviewer"]);
    store.close();
  });
});

describe("terminalPids", () => {
  it("names each agent by its tmux pane's process, and the server running it", async () => {
    const { store, agentId } = await claudeAgent();
    const pids = store.terminalPids();
    expect([pids.agents.get(PANE_PID), pids.shells.size]).toEqual([agentId, 0]);
  });

  it("names an agent on a holder by the holder's child, and the holder as what runs it", async () => {
    const { store, agentId } = await withAgent((s) =>
      fakeEnvironment(s, async (l) => ({
        runtime: {
          terminalId: l.terminalId,
          runtime: "holder",
          locator: { holderPid: "700", childPid: "701" },
        },
        externalRef: null,
      })),
    );
    const pids = store.terminalPids();
    expect([pids.agents.get(701), [...pids.runtimes]]).toEqual([agentId, [700]]);
  });
});

const holderAt = (generation: string, childPid: string) => ({
  runtime: "holder",
  locator: { holderPid: "700", holderStart: "1", childPid, childStart: "2", generation },
});

async function holderAgent() {
  return withAgent((s) =>
    fakeEnvironment(s, async (l) => ({
      runtime: { terminalId: l.terminalId, ...holderAt("0", "701") },
      externalRef: null,
    })),
  );
}

const adopted = (agentId: string, generation: string, childPid: string) =>
  ({
    type: "agent.process_adopted",
    entityId: agentId,
    actor: "system",
    payload: { runtimeRef: holderAt(generation, childPid) },
  }) as const;

describe("adopting a process started outside the daemon", () => {
  it("names the adopted process as the agent's, and the one it replaced as nobody's", async () => {
    const { store, agentId } = await holderAgent();
    store.append(adopted(agentId, "1", "900"));
    const pids = store.terminalPids();
    expect([pids.agents.get(900), pids.agents.has(701)]).toEqual([agentId, false]);
  });

  it("takes the generation it was found at, its terminal running and the agent waiting on its harness", async () => {
    const { store, agentId, terminalId } = await holderAgent();
    store.append({
      type: "agent.exited",
      entityId: agentId,
      actor: "system",
      payload: { exit: { type: "exited", code: 0 } },
    });
    store.append(adopted(agentId, "4", "900"));
    expect(store.agentTerminal({ terminalId })).toMatchObject({
      state: "starting",
      terminalState: "running",
      generation: 4,
    });
  });

  it("forgets the replaced process's signal", async () => {
    const { store, agentId } = await holderAgent();
    store.recordActivity(agentId, activity("working", "2026-11-12T10:00:00.000Z"));
    store.append(adopted(agentId, "1", "900"));
    expect(store.latestActivity(agentId)).toBeUndefined();
  });

  it("refuses a process at a generation no later than the recorded one", async () => {
    const { store, agentId } = await holderAgent();
    store.append(adopted(agentId, "2", "900"));
    expect(() => store.append(adopted(agentId, "2", "901"))).toThrow(/generation/);
    expect(() => store.append(adopted(agentId, "1", "902"))).toThrow(/generation/);
  });

  it("moves a shell's terminal to the adopted process", () => {
    const store = Store.open(dbPath());
    const terminalId = runningShell(store);
    store.append({
      type: "terminal.process_adopted",
      entityId: terminalId,
      actor: "system",
      payload: { runtimeRef: { runtime: "tmux", locator: { generation: "3" } } },
    });
    expect(store.shell(terminalId)).toMatchObject({ state: "running", generation: 3 });
  });
});

describe("launch roles", () => {
  it("upgrades a schema-24 database, its agents launched in no role and with no prompt to have changed from", () => {
    const path = dbPath();
    const v24 = Store.open(path, MIGRATIONS.slice(0, 24));
    const { agentId } = launch(v24, withEnvironment(v24));
    v24.append(running(agentId));
    v24.close();
    const upgraded = Store.open(path);
    const view = { ...testView, promptHash: () => "a prompt it was never given" };
    expect(upgraded.snapshot(view).agents[0]).toMatchObject({ role: null, promptChanged: false });
    upgraded.close();
  });

  it("keeps the role an agent was launched in, and the hash of the prompt its last start gave it", () => {
    const store = Store.open(dbPath());
    const environmentId = withEnvironment(store);
    const agentId = newId("agent");
    store.append({
      type: "agent.launched",
      entityId: agentId,
      actor: "system",
      payload: {
        environmentId,
        harness: "claude-code",
        project: "p",
        cwd: "/work",
        terminalId: newId("term"),
        role: "lead",
        promptHash: "h1",
      },
    });
    store.append(running(agentId));
    expect(store.agentLaunch(agentId)).toMatchObject({ role: "lead", promptHash: "h1" });
    store.close();
  });

  it("composes each role's prompt once a snapshot, and never says an ended agent's changed", () => {
    const store = Store.open(dbPath());
    const environmentId = withEnvironment(store);
    const launched = (role: string) => {
      const agentId = newId("agent");
      store.append({
        type: "agent.launched",
        entityId: agentId,
        actor: "system",
        payload: {
          environmentId,
          harness: "claude-code",
          project: "p",
          cwd: "/work",
          terminalId: newId("term"),
          role,
          promptHash: "old",
        },
      });
      return agentId;
    };
    const [a, , gone] = [launched("lead"), launched("lead"), launched("lead")];
    store.append(running(a));
    store.append({
      type: "agent.failed",
      entityId: gone,
      actor: "system",
      payload: { reason: "launch_rejected" },
    });
    const asked: (string | null)[] = [];
    const view = { ...testView, promptHash: (role: string | null) => (asked.push(role), "new") };
    expect([store.snapshot(view).agents.map((x) => x.promptChanged), asked]).toEqual([
      [true, true, false],
      ["lead"],
    ]);
    store.close();
  });
});

const queueMail = (store: Store, to: string, from?: string) => {
  const id = newId("msg");
  store.append({
    type: "mailbox.queued",
    entityId: id,
    actor: from ?? "system",
    payload: { agentId: to, body: "hi", ...(from === undefined ? {} : { from }) },
  });
  return id;
};
const moveMail = (store: Store, id: string, type: "mailbox.offered" | "mailbox.seen") =>
  store.append({
    type,
    entityId: id,
    actor: "system",
    payload: type === "mailbox.seen" ? { promptId: "p" } : {},
  });
const reportIdle = (store: Store, agentId: string) =>
  store.append({
    type: "agent.activity",
    entityId: agentId,
    actor: "system",
    payload: {
      value: "idle",
      source: "native",
      confidence: 1,
      observedAt: "2026-11-18T00:00:00Z",
    },
  });

describe("mail as a wait reads it", () => {
  it("finds the first mail the recipient sent back once the message reached it, and none before", () => {
    const store = Store.open(dbPath());
    const env = withEnvironment(store);
    const { agentId: a } = launch(store, env);
    const { agentId: b } = launch(store, env);
    const { agentId: c } = launch(store, env);
    queueMail(store, a, b);
    const sent = queueMail(store, b, a);
    // Written before the message reached b, it crossed it.
    queueMail(store, a, b);
    const before = store.replyTo(sent)?.replyId;
    moveMail(store, sent, "mailbox.offered");
    queueMail(store, a, c);
    queueMail(store, a);
    const reply = queueMail(store, a, b);
    queueMail(store, a, b);
    expect([before, store.replyTo(sent)]).toEqual([
      null,
      { from: a, to: b, state: "offered", replyId: reply },
    ]);
    expect([store.replyTo(queueMail(store, b))?.from, store.replyTo(newId("msg"))]).toEqual([
      null,
      undefined,
    ]);
    store.close();
  });

  it("counts mail on its way to an agent, and the event that last settled one", () => {
    const store = Store.open(dbPath());
    const { agentId } = launch(store, withEnvironment(store));
    const empty = store.turnAfterMail(agentId);
    const first = queueMail(store, agentId);
    const turn = reportIdle(store, agentId);
    moveMail(store, first, "mailbox.offered");
    const moving = store.turnAfterMail(agentId);
    const seen = moveMail(store, first, "mailbox.seen");
    const after = store.turnAfterMail(agentId);
    expect(empty).toEqual({
      activity: undefined,
      activityAt: null,
      inFlight: 0,
      lastSettled: null,
    });
    expect([moving.inFlight, moving.lastSettled, moving.activityAt]).toEqual([1, null, turn]);
    expect([after.inFlight, after.lastSettled, after.activity?.value]).toEqual([0, seen, "idle"]);
    store.close();
  });

  it("settles a message again only when it comes back from being on its way", () => {
    const store = Store.open(dbPath());
    const { agentId } = launch(store, withEnvironment(store));
    const id = queueMail(store, agentId);
    moveMail(store, id, "mailbox.seen");
    store.append({
      type: "mailbox.requeued",
      entityId: id,
      actor: "system",
      payload: { reason: "not_written" },
    });
    const back = store.turnAfterMail(agentId).inFlight;
    const again = moveMail(store, id, "mailbox.seen");
    store.append({ type: "mailbox.delivered", entityId: id, actor: "system", payload: {} });
    expect([back, store.turnAfterMail(agentId).lastSettled]).toEqual([1, again]);
    store.close();
  });

  it("upgrades a database from before senders were kept, each message's sender read back", () => {
    const path = dbPath();
    const old = Store.open(path, MIGRATIONS.slice(0, -1));
    const env = withEnvironment(old);
    const { agentId: a } = launch(old, env);
    const { agentId: b } = launch(old, env);
    old.close();
    const db = new DatabaseSync(path);
    /** A message as the daemon before this schema queued it, and moved it to `state`. */
    const queuedBefore = (to: string, from: string, state: string) => {
      const id = newId("msg");
      const { lastInsertRowid: at } = db
        .prepare(
          `INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
           SELECT host_id, ts, 'mailbox.queued', 'message', ?, ?, ? FROM events
           ORDER BY id DESC LIMIT 1`,
        )
        .run(id, from, JSON.stringify({ agentId: to, body: "hi", from }));
      db.prepare(
        `INSERT INTO mailbox (id, agent_session_id, body, state, created_event_id, updated_event_id)
         VALUES (?, ?, 'hi', ?, ?, ?)`,
      ).run(id, to, state, at, at);
      return { id, at: Number(at) };
    };
    /** An event the daemon before this schema recorded for message `id`, by its id. */
    const moved = (id: string, type: string) =>
      Number(
        db
          .prepare(
            `INSERT INTO events (host_id, ts, type, entity_type, entity_id, actor, payload)
             SELECT host_id, ts, ?, 'message', ?, 'system', '{}' FROM events
             ORDER BY id DESC LIMIT 1`,
          )
          .run(type, id).lastInsertRowid,
      );
    const sent = queuedBefore(b, a, "delivered");
    const seen = moved(sent.id, "mailbox.seen");
    const delivered = moved(sent.id, "mailbox.delivered");
    db.prepare("UPDATE mailbox SET updated_event_id = ? WHERE id = ?").run(delivered, sent.id);
    const reply = queuedBefore(a, b, "queued");
    queuedBefore(a, b, "undeliverable");
    db.close();
    const upgraded = Store.open(path);
    expect([
      upgraded.replyTo(sent.id)?.replyId,
      upgraded.turnAfterMail(b).lastSettled,
      upgraded.turnAfterMail(a).lastSettled,
    ]).toEqual([reply.id, seen, null]);
    upgraded.close();
  });
});

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, NUMBERED_MIGRATIONS } from "./migrations.ts";
import { NAMED_MIGRATIONS_VERSION, PRAGMAS, Store } from "./store.ts";

/**
 * Agents as a database had them before `2026-11-15-agent-names` named them: projects that clean
 * to one base in two cases, to nothing, and past the base's length, launched out of id order,
 * ended ones too.
 */
const AGENT_NAMES_SEED = `
INSERT INTO events (id, host_id, ts, type, entity_type, entity_id, actor, payload)
  VALUES (1, (SELECT id FROM host), '2026-11-15T00:00:00.000Z', 'environment.created', 'environment', 'env_1', 'system', '{}');
INSERT INTO environments (id, kind, created_event_id) VALUES ('env_1', 'local', 1);
WITH RECURSIVE n (id) AS (SELECT 2 UNION ALL SELECT id + 1 FROM n WHERE id < 8)
INSERT INTO events (id, host_id, ts, type, entity_type, entity_id, actor, payload)
  SELECT id, (SELECT id FROM host), '2026-11-15T00:00:00.000Z', 'agent.launched', 'agent', 'a', 'system', '{}'
  FROM n;
INSERT INTO agent_sessions (id, environment_id, harness, project, cwd, state, created_event_id, updated_event_id) VALUES
  ('agent_a', 'env_1', 'claude-code', 'my project!', '/w', 'running', 5, 5),
  ('agent_b', 'env_1', 'claude-code', 'My-Project', '/w', 'closed', 2, 2),
  ('agent_c', 'env_1', 'codex', '--__--', '/w', 'failed', 3, 3),
  ('agent_d', 'env_1', 'claude-code', '', '/w', 'running', 4, 4),
  ('agent_e', 'env_1', 'codex', 'a-very-long-project-name-that-goes-on-and-on-past-32', '/w', 'starting', 6, 6),
  ('agent_f', 'env_1', 'claude-code', 'my_project_', '/w', 'running', 7, 7),
  ('agent_g', 'env_1', 'claude-code', 'ünïcödé', '/w', 'running', 8, 8);
`;

/**
 * Each migration with code of its own: rows a database had before it ran, and the queries that
 * show what it made of them. A migration with a `run` hook and no entry here fails the fixture.
 */
const HOOKS: Readonly<Record<string, { seed: string; queries: readonly string[] }>> = {
  "2026-11-15-agent-names": {
    seed: AGENT_NAMES_SEED,
    queries: [
      "SELECT id, name FROM agent_sessions ORDER BY id",
      "SELECT base, last FROM agent_name_counters ORDER BY base",
    ],
  },
};

/** What each hook makes of its seed, run as a database that had those rows runs it. */
function hookResults(dir: string) {
  const hooked = MIGRATIONS.filter((m) => m.run !== undefined).map((m) => m.name);
  const missing = hooked.filter((name) => HOOKS[name] === undefined);
  if (missing.length > 0) throw new Error(`no seed for the hooks of ${missing.join(", ")}`);
  return Object.fromEntries(
    Object.entries(HOOKS).map(([name, { seed, queries }]) => {
      const path = join(dir, `${name}.db`);
      Store.open(
        path,
        MIGRATIONS.slice(
          0,
          MIGRATIONS.findIndex((m) => m.name === name),
        ),
      ).close();
      query(path, (db) => db.exec(seed));
      Store.open(path).close();
      const results = queries.map((sql) => ({
        sql,
        rows: query(path, (db) =>
          db
            .prepare(sql)
            .all()
            .map((row) => ({ ...row })),
        ),
      }));
      return [name, { seed, results }];
    }),
  );
}

/** Each pragma as the store sets it, and as SQLite then reads it back on that connection. */
function pragmas(dir: string) {
  const db = new DatabaseSync(join(dir, "pragmas.db"));
  try {
    return PRAGMAS.map(([name, value]) => {
      db.exec(`PRAGMA ${name} = ${value}`);
      const read = db.prepare(`PRAGMA ${name}`).get();
      return { name, value, reads: read === undefined ? null : Object.values(read)[0] };
    });
  } finally {
    db.close();
  }
}

/**
 * What the Rust store is held to, so the two daemons open one database the same way: every
 * migration as this daemon runs it, whether it has code of its own, the pragmas it opens a
 * database with, the schema a fresh database ends with, and what each migration with code does
 * to the rows a database had.
 */
export function storeFixture(): Record<string, string> {
  const dir = mkdtempSync(join(tmpdir(), "bazhen-store-fixture-"));
  try {
    const fresh = join(dir, "fresh.db");
    Store.open(fresh).close();
    const fixture = {
      migrations: MIGRATIONS.map(({ name, sql, run }) => ({ name, sql, run: run !== undefined })),
      numbered: NUMBERED_MIGRATIONS,
      namedMigrationsVersion: NAMED_MIGRATIONS_VERSION,
      schema: query(fresh, (db) =>
        db
          .prepare(
            "SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name, tbl_name",
          )
          .all()
          .map((row) => ({ ...row })),
      ),
      pragmas: pragmas(dir),
      hooks: hookResults(dir),
    };
    return { "typescript.json": `${JSON.stringify(fixture, null, 2)}\n` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function query<T>(path: string, read: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(path);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

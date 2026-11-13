export interface Migration {
  readonly version: number;
  readonly sql: string;
}

// Append-only. A shipped migration has already run on users' databases, so editing it forks
// their schema from new installs; add a new version instead, with a medium test that upgrades
// from the previous one.
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE host (
        id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE events (
        id INTEGER PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES host (id),
        ts TEXT NOT NULL,
        type TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        actor TEXT NOT NULL,
        causation_id INTEGER,
        correlation_id TEXT,
        payload TEXT NOT NULL
      ) STRICT;
      CREATE INDEX events_entity ON events (entity_type, entity_id, id);

      CREATE TABLE terminals (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES host (id),
        state TEXT NOT NULL,
        generation INTEGER NOT NULL,
        runtime TEXT NOT NULL,
        locator TEXT NOT NULL,
        created_event_id INTEGER NOT NULL REFERENCES events (id),
        updated_event_id INTEGER NOT NULL REFERENCES events (id)
      ) STRICT;
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE environments (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        created_event_id INTEGER NOT NULL REFERENCES events (id)
      ) STRICT;

      CREATE TABLE agent_sessions (
        id TEXT PRIMARY KEY,
        environment_id TEXT NOT NULL REFERENCES environments (id),
        harness TEXT NOT NULL,
        project TEXT NOT NULL,
        cwd TEXT NOT NULL,
        state TEXT NOT NULL,
        terminal_id TEXT,
        external_ref TEXT,
        created_event_id INTEGER NOT NULL REFERENCES events (id),
        updated_event_id INTEGER NOT NULL REFERENCES events (id)
      ) STRICT;

      -- Rebuilt rather than altered: a terminal that is still being created has no runtime
      -- incarnation yet, and SQLite can't relax a column's NOT NULL in place.
      CREATE TABLE terminals_v2 (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES host (id),
        state TEXT NOT NULL,
        generation INTEGER NOT NULL,
        runtime TEXT,
        locator TEXT,
        environment_id TEXT REFERENCES environments (id),
        kind TEXT NOT NULL DEFAULT 'agent',
        agent_session_id TEXT REFERENCES agent_sessions (id),
        created_event_id INTEGER NOT NULL REFERENCES events (id),
        updated_event_id INTEGER NOT NULL REFERENCES events (id)
      ) STRICT;
      INSERT INTO terminals_v2
        (id, host_id, state, generation, runtime, locator, created_event_id, updated_event_id)
        SELECT id, host_id, state, generation, runtime, locator, created_event_id, updated_event_id
        FROM terminals;
      DROP TABLE terminals;
      ALTER TABLE terminals_v2 RENAME TO terminals;
      CREATE INDEX terminals_agent ON terminals (agent_session_id);

      CREATE TABLE idempotency_keys (
        key TEXT PRIMARY KEY,
        response TEXT NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE attachments_open (
        id TEXT PRIMARY KEY,
        terminal_id TEXT NOT NULL REFERENCES terminals (id),
        mode TEXT NOT NULL,
        started_event_id INTEGER NOT NULL REFERENCES events (id)
      ) STRICT;

      CREATE TABLE leases (
        terminal_id TEXT PRIMARY KEY REFERENCES terminals (id),
        holder TEXT,
        epoch INTEGER NOT NULL,
        updated_event_id INTEGER NOT NULL REFERENCES events (id)
      ) STRICT;
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE mailbox (
        id TEXT PRIMARY KEY,
        agent_session_id TEXT NOT NULL REFERENCES agent_sessions (id),
        body TEXT NOT NULL,
        state TEXT NOT NULL,
        prompt_id TEXT,
        created_event_id INTEGER NOT NULL REFERENCES events (id),
        updated_event_id INTEGER NOT NULL REFERENCES events (id)
      ) STRICT;
      CREATE INDEX mailbox_agent_state ON mailbox (agent_session_id, state);

      CREATE TABLE attention_items (
        id TEXT PRIMARY KEY,
        agent_session_id TEXT NOT NULL REFERENCES agent_sessions (id),
        state TEXT NOT NULL,
        close_reason TEXT,
        summary TEXT NOT NULL,
        tool_use_id TEXT,
        main_agent INTEGER NOT NULL,
        created_event_id INTEGER NOT NULL REFERENCES events (id),
        updated_event_id INTEGER NOT NULL REFERENCES events (id)
      ) STRICT;
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE mailbox ADD COLUMN first_offered_event_id INTEGER REFERENCES events (id);
    `,
  },
  {
    version: 6,
    sql: `
      -- One row. Cursors carry the epoch, so a client of another database is told to reset;
      -- pruned_through is the highest id retention has passed, deleted or kept.
      CREATE TABLE event_log (
        epoch TEXT NOT NULL,
        pruned_through INTEGER NOT NULL
      ) STRICT;
      INSERT INTO event_log (epoch, pruned_through) VALUES (lower(hex(randomblob(16))), 0);
    `,
  },
  {
    version: 7,
    sql: `
      ALTER TABLE terminals ADD COLUMN exit TEXT;
    `,
  },
  {
    version: 8,
    sql: `
      -- The version each harness's own server last answered on, per environment.
      CREATE TABLE harness_versions (
        environment_id TEXT NOT NULL REFERENCES environments (id),
        harness TEXT NOT NULL,
        version TEXT NOT NULL,
        updated_event_id INTEGER NOT NULL REFERENCES events (id),
        PRIMARY KEY (environment_id, harness)
      ) STRICT;
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

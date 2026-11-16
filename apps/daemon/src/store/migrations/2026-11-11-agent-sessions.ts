import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-11-agent-sessions",
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
} satisfies Migration);

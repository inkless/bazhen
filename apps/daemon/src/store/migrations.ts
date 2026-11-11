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
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

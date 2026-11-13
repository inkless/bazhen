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
  {
    version: 9,
    sql: `
      -- The latest activity signal per agent (foundation-design §4.6), as its JSON. Cleared when
      -- the agent's process is replaced or closed, so a signal never outlives its process.
      CREATE TABLE activity_latest (
        agent_session_id TEXT PRIMARY KEY REFERENCES agent_sessions (id),
        activity TEXT NOT NULL,
        updated_event_id INTEGER NOT NULL REFERENCES events (id)
      ) STRICT;
    `,
  },
  {
    version: 10,
    sql: `
      -- How often the agent's side failed each message (a failed or interrupted turn, or a wake
      -- it never saw), for the re-offer cap (§5.6).
      ALTER TABLE mailbox ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 11,
    sql: `
      -- The theme the terminal's process was started for, light or dark; NULL when none was
      -- named, which is drawn and reported as dark.
      ALTER TABLE terminals ADD COLUMN theme TEXT;
    `,
  },
  {
    version: 12,
    sql: `
      -- The model the agent runs and its context use, as JSON, once its harness reports them.
      ALTER TABLE agent_sessions ADD COLUMN usage TEXT;
    `,
  },
  {
    version: 13,
    sql: `
      -- A shell terminal has no agent session above it (foundation-design §4.8): it keeps the
      -- directory it was opened in, and the agent it is shown with, if any, here.
      ALTER TABLE terminals ADD COLUMN cwd TEXT;
      ALTER TABLE terminals ADD COLUMN linked_agent_id TEXT REFERENCES agent_sessions (id);
      CREATE INDEX terminals_linked_agent ON terminals (linked_agent_id);
    `,
  },
  {
    version: 14,
    sql: `
      -- What an item is about (foundation-design §4.6); every item before kinds was an approval.
      ALTER TABLE attention_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'approval';
      ALTER TABLE attention_items ADD COLUMN task_id TEXT;
      ALTER TABLE attention_items ADD COLUMN message_id TEXT;
    `,
  },
  {
    version: 15,
    sql: `
      -- The name a user gave a shell; NULL until they do.
      ALTER TABLE terminals ADD COLUMN name TEXT;
    `,
  },
  {
    version: 16,
    sql: `
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        brief TEXT NOT NULL,
        state TEXT NOT NULL,
        -- NULL when the human created it.
        owner_agent_id TEXT REFERENCES agent_sessions (id),
        parent_task_id TEXT REFERENCES tasks (id),
        note TEXT,
        created_event_id INTEGER NOT NULL REFERENCES events (id),
        updated_event_id INTEGER NOT NULL REFERENCES events (id)
      ) STRICT;
      CREATE INDEX tasks_parent ON tasks (parent_task_id);

      CREATE TABLE assignments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks (id),
        agent_session_id TEXT NOT NULL REFERENCES agent_sessions (id),
        role TEXT NOT NULL,
        parent_assignment_id TEXT REFERENCES assignments (id),
        state TEXT NOT NULL,
        end_reason TEXT,
        created_event_id INTEGER NOT NULL REFERENCES events (id),
        updated_event_id INTEGER NOT NULL REFERENCES events (id)
      ) STRICT;
      CREATE INDEX assignments_task ON assignments (task_id, state);
      CREATE INDEX assignments_agent ON assignments (agent_session_id, state);
      CREATE INDEX assignments_parent ON assignments (parent_assignment_id);
    `,
  },
  {
    version: 17,
    sql: `
      -- Paired browsers (foundation-design §9.1). Only a hash of each token is kept, and it is
      -- written beside device.paired, never in it, so the event log holds no credential.
      CREATE TABLE devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        paired_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        revoked_at TEXT,
        -- Paired over HTTPS: its cookie is __Host- and Secure, and it lapses after 30 days unused,
        -- rather than the 1 day a loopback cookie, which other local ports also receive, keeps.
        secure INTEGER NOT NULL
      ) STRICT;
    `,
  },
  {
    version: 18,
    sql: `
      -- What runs in a shell's foreground and since when, as JSON, from its events; NULL at the
      -- shell's prompt.
      ALTER TABLE terminals ADD COLUMN foreground TEXT;
      -- The directory the shell was last seen in, for a restart to open in: written straight onto
      -- the row as the foreground is read, never by an event, and lost if the projection is rebuilt.
      ALTER TABLE terminals ADD COLUMN current_cwd TEXT;
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

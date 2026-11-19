
    ALTER TABLE agent_sessions ADD COLUMN name TEXT;
    -- The last number a default name took under each base, which no later default takes again.
    CREATE TABLE agent_name_counters (
      base TEXT PRIMARY KEY COLLATE NOCASE,
      last INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX agent_sessions_live_name ON agent_sessions (name COLLATE NOCASE)
      WHERE state NOT IN ('closed', 'failed');
  
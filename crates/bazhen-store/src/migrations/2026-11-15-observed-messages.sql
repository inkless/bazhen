
    -- The name the agent's harness session was last started with, which it answers to until
    -- its next start, whatever the agent is renamed since. NULL until a start records one.
    ALTER TABLE agent_sessions ADD COLUMN harness_name TEXT;
    -- Messages agents sent each other through their harness's own channel; the text is only
    -- in the event log.
    CREATE TABLE observed_messages (
      id TEXT PRIMARY KEY,
      from_agent_id TEXT NOT NULL,
      to_agent_id TEXT NOT NULL,
      summary TEXT NOT NULL,
      accepted INTEGER NOT NULL,
      tool_use_id TEXT NOT NULL,
      created_event_id INTEGER NOT NULL,
      UNIQUE (from_agent_id, tool_use_id)
    ) STRICT;
    -- Every state read takes the latest of them.
    CREATE INDEX observed_messages_created ON observed_messages (created_event_id);
  
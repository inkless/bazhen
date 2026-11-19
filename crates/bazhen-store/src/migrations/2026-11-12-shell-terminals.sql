
    -- A shell terminal has no agent session above it (foundation-design §4.8): it keeps the
    -- directory it was opened in, and the agent it is shown with, if any, here.
    ALTER TABLE terminals ADD COLUMN cwd TEXT;
    ALTER TABLE terminals ADD COLUMN linked_agent_id TEXT REFERENCES agent_sessions (id);
    CREATE INDEX terminals_linked_agent ON terminals (linked_agent_id);
  
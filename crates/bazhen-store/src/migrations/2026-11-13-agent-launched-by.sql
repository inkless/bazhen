
    -- The agent that launched this one to delegate to it; NULL when the human launched it.
    ALTER TABLE agent_sessions ADD COLUMN launched_by TEXT REFERENCES agent_sessions (id);
  
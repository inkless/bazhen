
    -- The model the agent runs and its context use, as JSON, once its harness reports them.
    ALTER TABLE agent_sessions ADD COLUMN usage TEXT;
  

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
  
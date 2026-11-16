import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-15-task-notes",
  sql: `
    -- Notes on a task from the agent working it or the human; the latest of an agent's is its
    -- headline, and the latest handoff on a task goes into the next assignee's brief.
    CREATE TABLE task_notes (
      event_id INTEGER PRIMARY KEY REFERENCES events (id),
      task_id TEXT NOT NULL REFERENCES tasks (id),
      -- NULL when the human wrote it, with its role.
      agent_session_id TEXT REFERENCES agent_sessions (id),
      author_role TEXT,
      text TEXT NOT NULL,
      handoff INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX task_notes_task ON task_notes (task_id, handoff, event_id);
    CREATE INDEX task_notes_agent ON task_notes (agent_session_id, event_id);
  `,
} satisfies Migration);

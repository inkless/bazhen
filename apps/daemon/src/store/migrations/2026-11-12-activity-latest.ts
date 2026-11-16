import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-12-activity-latest",
  sql: `
    -- The latest activity signal per agent (foundation-design §4.6), as its JSON. Cleared when
    -- the agent's process is replaced or closed, so a signal never outlives its process.
    CREATE TABLE activity_latest (
      agent_session_id TEXT PRIMARY KEY REFERENCES agent_sessions (id),
      activity TEXT NOT NULL,
      updated_event_id INTEGER NOT NULL REFERENCES events (id)
    ) STRICT;
  `,
} satisfies Migration);

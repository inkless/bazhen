import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-12-mailbox-and-attention",
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
} satisfies Migration);

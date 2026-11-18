import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-18-mailbox-sender-and-settled",
  sql: `
    -- The agent that sent the message; null when the human did.
    ALTER TABLE mailbox ADD COLUMN from_agent_id TEXT;
    -- The event that last moved it from on its way to settled (seen, delivered or undeliverable).
    ALTER TABLE mailbox ADD COLUMN settled_event_id INTEGER REFERENCES events (id);
    UPDATE mailbox SET from_agent_id = (
      SELECT json_extract(e.payload, '$.from') FROM events e WHERE e.id = mailbox.created_event_id
    );
    UPDATE mailbox SET settled_event_id = updated_event_id
      WHERE state IN ('seen', 'delivered', 'undeliverable');
    CREATE INDEX mailbox_reply ON mailbox (from_agent_id, agent_session_id, created_event_id);
  `,
} satisfies Migration);

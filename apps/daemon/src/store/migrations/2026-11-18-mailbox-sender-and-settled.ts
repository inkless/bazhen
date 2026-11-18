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
    -- When it reached the agent, not when it last moved: a message seen, then delivered at its
    -- turn's end, settled when seen; one folded into a running turn, when emitted into it. Only
    -- since it was last requeued, if it was.
    UPDATE mailbox SET settled_event_id = coalesce(
      (SELECT max(e.id) FROM events e
        WHERE e.entity_type = 'message' AND e.entity_id = mailbox.id
          AND e.type IN ('mailbox.emitted', 'mailbox.seen')
          AND e.id > coalesce((SELECT max(r.id) FROM events r
            WHERE r.entity_type = 'message' AND r.entity_id = mailbox.id
              AND r.type = 'mailbox.requeued'), 0)),
      updated_event_id)
      WHERE state IN ('seen', 'delivered', 'undeliverable');
    CREATE INDEX mailbox_reply ON mailbox (from_agent_id, agent_session_id, created_event_id);
  `,
} satisfies Migration);

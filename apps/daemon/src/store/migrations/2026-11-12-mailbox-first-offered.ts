import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-12-mailbox-first-offered",
  sql: `
    ALTER TABLE mailbox ADD COLUMN first_offered_event_id INTEGER REFERENCES events (id);
  `,
} satisfies Migration);

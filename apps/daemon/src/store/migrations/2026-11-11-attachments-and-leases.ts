import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-11-attachments-and-leases",
  sql: `
    CREATE TABLE attachments_open (
      id TEXT PRIMARY KEY,
      terminal_id TEXT NOT NULL REFERENCES terminals (id),
      mode TEXT NOT NULL,
      started_event_id INTEGER NOT NULL REFERENCES events (id)
    ) STRICT;

    CREATE TABLE leases (
      terminal_id TEXT PRIMARY KEY REFERENCES terminals (id),
      holder TEXT,
      epoch INTEGER NOT NULL,
      updated_event_id INTEGER NOT NULL REFERENCES events (id)
    ) STRICT;
  `,
} satisfies Migration);

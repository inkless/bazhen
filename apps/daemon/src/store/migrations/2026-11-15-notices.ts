import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-15-notices",
  sql: `
    -- What the human should know that no agent raised, such as a device pairing. A device has
    -- at most one notice of each kind, so the devices paired bound the table.
    CREATE TABLE notices (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      state TEXT NOT NULL,
      close_reason TEXT,
      summary TEXT NOT NULL,
      device_id TEXT REFERENCES devices (id),
      device_name TEXT,
      device_origin TEXT,
      device_address TEXT,
      -- Who closed it, and, advisory, the device whose shell asked, as its environment claimed.
      closed_by TEXT,
      closed_from_device TEXT REFERENCES devices (id),
      created_event_id INTEGER NOT NULL REFERENCES events (id),
      updated_event_id INTEGER NOT NULL REFERENCES events (id),
      UNIQUE (kind, device_id)
    ) STRICT;
    CREATE INDEX notices_state ON notices (state, created_event_id);
  `,
} satisfies Migration);

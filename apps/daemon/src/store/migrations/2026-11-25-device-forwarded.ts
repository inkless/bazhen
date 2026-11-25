import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-25-device-forwarded",
  sql: `
    -- Whether the device was paired through a forwarder: over loopback TCP from a socket no
    -- readable process holds, each that may hold it the human's. Only such a device's cookie lets
    -- such a caller through as the human.
    ALTER TABLE devices ADD COLUMN forwarded INTEGER NOT NULL DEFAULT 0;
  `,
} satisfies Migration);

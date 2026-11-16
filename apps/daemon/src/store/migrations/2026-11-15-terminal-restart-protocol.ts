import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-15-terminal-restart-protocol",
  sql: `
    -- The versions a terminal's holder speaks, as a JSON array, once it is seen on a holder this
    -- build can't fully serve; NULL while it needs no restart. A holder runs one binary for life,
    -- so it stays through respawns until a build that serves it in full reads it.
    ALTER TABLE terminals ADD COLUMN restart_protocol TEXT;
  `,
} satisfies Migration);

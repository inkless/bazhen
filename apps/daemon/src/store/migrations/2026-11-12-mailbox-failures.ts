import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-12-mailbox-failures",
  sql: `
    -- How often the agent's side failed each message (a failed or interrupted turn, or a wake
    -- it never saw), for the re-offer cap (§5.6).
    ALTER TABLE mailbox ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
  `,
} satisfies Migration);

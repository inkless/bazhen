import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-13-shell-names",
  sql: `
    -- The name a user gave a shell; NULL until they do.
    ALTER TABLE terminals ADD COLUMN name TEXT;
  `,
} satisfies Migration);

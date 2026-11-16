import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-12-terminal-exit",
  sql: `
    ALTER TABLE terminals ADD COLUMN exit TEXT;
  `,
} satisfies Migration);

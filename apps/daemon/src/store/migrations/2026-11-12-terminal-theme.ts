import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-12-terminal-theme",
  sql: `
    -- The theme the terminal's process was started for, light or dark; NULL when none was
    -- named, which is drawn and reported as dark.
    ALTER TABLE terminals ADD COLUMN theme TEXT;
  `,
} satisfies Migration);

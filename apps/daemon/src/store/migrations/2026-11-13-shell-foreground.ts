import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-13-shell-foreground",
  sql: `
    -- What runs in a shell's foreground and since when, as JSON, from its events; NULL at the
    -- shell's prompt.
    ALTER TABLE terminals ADD COLUMN foreground TEXT;
    -- The directory the shell was last seen in, for a restart to open in: written straight onto
    -- the row as the foreground is read, never by an event, and lost if the projection is rebuilt.
    ALTER TABLE terminals ADD COLUMN current_cwd TEXT;
  `,
} satisfies Migration);

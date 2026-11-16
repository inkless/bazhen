import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-15-shell-last-command",
  sql: `
    -- The line the user last ran in a shell, as its shell integration reported it, to type back
    -- into its replacement. It can hold a secret the user typed, so it is written straight onto
    -- the row and never by an event, and cleared once the shell closes or fails.
    ALTER TABLE terminals ADD COLUMN last_command TEXT;
    -- The number of the report that set it: an older report, arriving late, changes nothing.
    ALTER TABLE terminals ADD COLUMN last_command_seq INTEGER;
    -- The SHA-256, in hex, of the token a live shell's integration reports with; the token
    -- itself is only in the shell's environment. NULL once the shell can report no more.
    ALTER TABLE terminals ADD COLUMN report_token_hash TEXT;
  `,
} satisfies Migration);

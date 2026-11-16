import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-12-event-log-epoch",
  sql: `
    -- One row. Cursors carry the epoch, so a client of another database is told to reset;
    -- pruned_through is the highest id retention has passed, deleted or kept.
    CREATE TABLE event_log (
      epoch TEXT NOT NULL,
      pruned_through INTEGER NOT NULL
    ) STRICT;
    INSERT INTO event_log (epoch, pruned_through) VALUES (lower(hex(randomblob(16))), 0);
  `,
} satisfies Migration);

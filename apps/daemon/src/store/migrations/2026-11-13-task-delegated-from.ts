import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-13-task-delegated-from",
  sql: `
    -- The assignment an agent delegated the task under; NULL for the human's tasks, and for one
    -- an agent delegated as the parent's owner.
    ALTER TABLE tasks ADD COLUMN delegated_from TEXT REFERENCES assignments (id);
  `,
} satisfies Migration);

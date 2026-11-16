import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-12-attention-kinds",
  sql: `
    -- What an item is about (foundation-design §4.6); every item before kinds was an approval.
    ALTER TABLE attention_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'approval';
    ALTER TABLE attention_items ADD COLUMN task_id TEXT;
    ALTER TABLE attention_items ADD COLUMN message_id TEXT;
  `,
} satisfies Migration);

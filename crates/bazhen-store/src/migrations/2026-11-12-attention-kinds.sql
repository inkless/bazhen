
    -- What an item is about (foundation-design §4.6); every item before kinds was an approval.
    ALTER TABLE attention_items ADD COLUMN kind TEXT NOT NULL DEFAULT 'approval';
    ALTER TABLE attention_items ADD COLUMN task_id TEXT;
    ALTER TABLE attention_items ADD COLUMN message_id TEXT;
  
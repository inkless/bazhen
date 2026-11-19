
    -- How often the agent's side failed each message (a failed or interrupted turn, or a wake
    -- it never saw), for the re-offer cap (§5.6).
    ALTER TABLE mailbox ADD COLUMN failures INTEGER NOT NULL DEFAULT 0;
  
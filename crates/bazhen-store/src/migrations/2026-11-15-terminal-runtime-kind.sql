
    -- The runtime a terminal is created on, from the moment it is requested, so a terminal still
    -- being created is looked for there; every terminal before it ran on tmux.
    ALTER TABLE terminals ADD COLUMN runtime_kind TEXT NOT NULL DEFAULT 'tmux';
  
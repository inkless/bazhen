
    -- Paired browsers (foundation-design §9.1). Only a hash of each token is kept, and it is
    -- written beside device.paired, never in it, so the event log holds no credential.
    CREATE TABLE devices (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      paired_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      revoked_at TEXT,
      -- Paired over HTTPS: its cookie is __Host- and Secure, and it lapses after 30 days unused,
      -- rather than the 1 day a loopback cookie, which other local ports also receive, keeps.
      secure INTEGER NOT NULL
    ) STRICT;
  
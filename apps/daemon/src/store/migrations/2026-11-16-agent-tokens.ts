import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-16-agent-tokens",
  sql: `
    -- The SHA-256, in hex, of the token the agent's current process proves itself with; the
    -- token itself is only in a 0600 file its environment names. Each start replaces it.
    ALTER TABLE agent_sessions ADD COLUMN token_hash TEXT;
    CREATE UNIQUE INDEX agent_sessions_token ON agent_sessions (token_hash)
      WHERE token_hash IS NOT NULL;
    -- 1 for an agent running when agents got tokens: it has none, and is known by the id it
    -- names until a start of its own gives it one. Never set again once cleared.
    ALTER TABLE agent_sessions ADD COLUMN untokened INTEGER NOT NULL DEFAULT 0;
    UPDATE agent_sessions SET untokened = 1 WHERE state NOT IN ('closed', 'failed');
  `,
} satisfies Migration);

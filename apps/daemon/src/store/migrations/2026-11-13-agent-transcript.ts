import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-13-agent-transcript",
  sql: `
    -- Where the bound harness session keeps its conversation, as its hooks last said; NULL
    -- until they say, and again whenever the agent moves to another session.
    ALTER TABLE agent_sessions ADD COLUMN transcript TEXT;
  `,
} satisfies Migration);

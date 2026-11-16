import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-12-agent-usage",
  sql: `
    -- The model the agent runs and its context use, as JSON, once its harness reports them.
    ALTER TABLE agent_sessions ADD COLUMN usage TEXT;
  `,
} satisfies Migration);

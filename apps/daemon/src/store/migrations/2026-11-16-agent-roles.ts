import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-16-agent-roles",
  sql: `
    ALTER TABLE agent_sessions ADD COLUMN role TEXT;
    ALTER TABLE agent_sessions ADD COLUMN prompt_hash TEXT;
  `,
} satisfies Migration);

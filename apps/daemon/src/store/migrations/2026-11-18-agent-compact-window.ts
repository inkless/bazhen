import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-18-agent-compact-window",
  sql: `ALTER TABLE agent_sessions ADD COLUMN compact_window INTEGER;`,
} satisfies Migration);

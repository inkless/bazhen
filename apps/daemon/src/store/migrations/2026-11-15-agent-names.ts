import type { DatabaseSync } from "node:sqlite";
import type { Migration } from "../migrations.ts";

export default Object.freeze({
  name: "2026-11-15-agent-names",
  sql: `
    ALTER TABLE agent_sessions ADD COLUMN name TEXT;
    -- The last number a default name took under each base, which no later default takes again.
    CREATE TABLE agent_name_counters (
      base TEXT PRIMARY KEY COLLATE NOCASE,
      last INTEGER NOT NULL
    ) STRICT;
    CREATE UNIQUE INDEX agent_sessions_live_name ON agent_sessions (name COLLATE NOCASE)
      WHERE state NOT IN ('closed', 'failed');
  `,
  run: nameEveryAgent,
} satisfies Migration);

const trimAt24 = (s: string) => s.replaceAll(/^[-_]+|[-_]+$/g, "");

/**
 * `nameBase` as this migration ran it, frozen here so a later change to the live one can't name
 * a database upgraded after it differently from one upgraded before.
 */
function baseAt24(project: string): string {
  const base = trimAt24(trimAt24(project.replaceAll(/[^A-Za-z0-9_-]+/g, "-")).slice(0, 32));
  return base === "" ? "agent" : base;
}

/** Gives each agent, ended ones too, its project's default name, numbered in launch order. */
function nameEveryAgent(db: DatabaseSync): void {
  const last = new Map<string, { base: string; n: number }>();
  const rename = db.prepare("UPDATE agent_sessions SET name = ? WHERE id = ?");
  const agents = db.prepare("SELECT id, project FROM agent_sessions ORDER BY created_event_id");
  for (const { id, project } of agents.all()) {
    const base = baseAt24(String(project));
    const counter = last.get(base.toLowerCase()) ?? { base, n: 0 };
    counter.n += 1;
    last.set(base.toLowerCase(), counter);
    rename.run(`${base}-${counter.n}`, String(id));
  }
  const count = db.prepare("INSERT INTO agent_name_counters (base, last) VALUES (?, ?)");
  for (const { base, n } of last.values()) count.run(base, n);
}

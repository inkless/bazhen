import { describe, expect, it } from "vitest";
import { z } from "zod";
import { storeFixture } from "./fixture.ts";
import { MIGRATIONS } from "./migrations.ts";

const Fixture = z.object({
  migrations: z.array(z.object({ name: z.string(), sql: z.string(), run: z.boolean() })),
  schema: z.array(z.object({ type: z.string(), name: z.string() })),
  pragmas: z.array(z.object({ name: z.string(), value: z.string(), reads: z.unknown() })),
  hooks: z.record(
    z.string(),
    z.object({
      seed: z.string(),
      results: z.array(
        z.object({ sql: z.string(), rows: z.array(z.record(z.string(), z.unknown())) }),
      ),
    }),
  ),
});

const fixture = () => {
  const files = storeFixture();
  expect(Object.keys(files)).toEqual(["typescript.json", "events.json"]);
  return Fixture.parse(JSON.parse(files["typescript.json"] ?? ""));
};

/** The agents and counters the agent-names migration left, as the fixture records them. */
function agentNamesRows(): [Record<string, unknown>[], Record<string, unknown>[]] {
  const [agents, counters] = fixture().hooks["2026-11-15-agent-names"]?.results ?? [];
  if (agents === undefined || counters === undefined) throw new Error("no agent-names rows");
  return [agents.rows, counters.rows];
}

describe("storeFixture", () => {
  it("records every migration in order, and the schema they leave", () => {
    const { migrations, schema } = fixture();
    expect(migrations).toEqual(
      MIGRATIONS.map(({ name, sql, run }) => ({ name, sql, run: run !== undefined })),
    );
    expect(schema).toContainEqual(expect.objectContaining({ type: "table", name: "migrations" }));
    expect(schema).toContainEqual(
      expect.objectContaining({ type: "index", name: "agent_sessions_live_name" }),
    );
  });

  it("records each migration's code, and the pragmas as SQLite reads them back", () => {
    const { migrations, hooks, pragmas } = fixture();
    expect(Object.keys(hooks)).toEqual(migrations.filter((m) => m.run).map((m) => m.name));
    expect(pragmas).toContainEqual({ name: "foreign_keys", value: "ON", reads: 1 });
    expect(pragmas).toContainEqual({ name: "journal_mode", value: "WAL", reads: "wal" });
  });

  it("seeds agents that reach each rule the agent-names migration has", () => {
    const [agents, counters] = agentNamesRows();
    const named = Object.fromEntries(agents.map((a) => [a.id, a.name]));
    // Numbered in launch order, under one base however it is spelt, each by its own spelling.
    expect([named.agent_b, named.agent_a]).toEqual(["My-Project-1", "my-project-2"]);
    expect(counters).toContainEqual({ base: "My-Project", last: 2 });
    // Nothing left after cleaning, or nothing at all, is "agent".
    expect([named.agent_c, named.agent_d]).toEqual(["agent-1", "agent-2"]);
    // Cut to 32, and trimmed of `-` and `_` after the cut too.
    expect(named.agent_e).toBe("a-very-long-project-name-that-go-1");
    expect(named.agent_f).toBe("my_project-1");
    expect(named.agent_g).toBe("n-c-d-1");
  });
});

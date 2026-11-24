import { describe, expect, it } from "vitest";
import { EVENTS, type StateSnapshot } from "@bazhen/protocol";
import { agentEventFixture } from "./agent-event-fixtures.ts";

const files = agentEventFixture();
const byName = (a: string, b: string) => a.localeCompare(b);

interface Fixture {
  host: string;
  steps: readonly { type: string; refused?: string }[];
  tables: Record<string, readonly Record<string, unknown>[]>;
}

const fixture: Fixture = JSON.parse(files["events.json"] ?? "null");
const { snapshot }: { snapshot: StateSnapshot } = JSON.parse(files["snapshot.json"] ?? "null");
const appended = fixture.steps.filter((s) => s.refused === undefined);
const hosts = Object.values(fixture.tables)
  .flat()
  .map((row) => row.host_id)
  .filter((host) => host !== undefined);

describe("the agent event fixture", () => {
  it("writes only the events, what they left and the snapshot of it", () => {
    expect(Object.keys(files)).toEqual(["events.json", "snapshot.json"]);
  });

  it("snapshots agents and items for the human, with what the view said of them", () => {
    expect({
      agents: snapshot.agents.length,
      attention: snapshot.attention.length,
      listening: snapshot.agents.some((a) => a.listening),
      resumable: new Set(snapshot.agents.map((a) => a.resumable)),
      promptChanged: new Set(snapshot.agents.map((a) => a.promptChanged)),
      headlines: snapshot.agents.filter((a) => a.headline !== null).length,
      actions: new Set(snapshot.attention.map((i) => i.actions.length)).size,
    }).toEqual({
      agents: 10,
      attention: 4,
      listening: true,
      resumable: new Set([true, false]),
      promptChanged: new Set([true, false]),
      headlines: 2,
      actions: 3,
    });
  });

  it("appends every event of agents, mail, attention and tasks the protocol has at least once", () => {
    const families = ["agent.", "mailbox.", "message.", "attention.", "task.", "assignment."];
    const ofThem = (type: string) => families.some((family) => type.startsWith(family));
    const seen = [...new Set(appended.map((s) => s.type))].filter(ofThem).toSorted(byName);
    expect(seen).toEqual(Object.keys(EVENTS).filter(ofThem).toSorted(byName));
  });

  it("records refusals as well as appends", () => {
    expect(fixture.steps.length - appended.length).toBeGreaterThan(0);
  });

  it("leaves a row in each table it records", () => {
    expect(Object.entries(fixture.tables).filter(([, rows]) => rows.length === 0)).toEqual([]);
  });

  it("names the host as the fixture does, not as the store it ran on did", () => {
    expect(hosts.length).toBeGreaterThan(0);
    expect([...new Set(hosts)]).toEqual([fixture.host]);
  });

  it("records nothing that changes from one run to the next", () => {
    expect(agentEventFixture()).toEqual(files);
  });
});

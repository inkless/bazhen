import { describe, expect, it } from "vitest";
import { EVENTS } from "@bazhen/protocol";
import { agentEventFixture } from "./agent-event-fixtures.ts";

const files = agentEventFixture();
const byName = (a: string, b: string) => a.localeCompare(b);

interface Fixture {
  host: string;
  steps: readonly { type: string; refused?: string }[];
  tables: Record<string, readonly Record<string, unknown>[]>;
}

const fixture: Fixture = JSON.parse(files["events.json"] ?? "null");
const appended = fixture.steps.filter((s) => s.refused === undefined);
const hosts = Object.values(fixture.tables)
  .flat()
  .map((row) => row.host_id)
  .filter((host) => host !== undefined);

describe("the agent event fixture", () => {
  it("writes only the events and what they left", () => {
    expect(Object.keys(files)).toEqual(["events.json"]);
  });

  it("appends every agent event the protocol has at least once", () => {
    const agentEvents = Object.keys(EVENTS)
      .filter((type) => type.startsWith("agent."))
      .toSorted(byName);
    const seen = [...new Set(appended.map((s) => s.type))]
      .filter((type) => type.startsWith("agent."))
      .toSorted(byName);
    expect(seen).toEqual(agentEvents);
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

import { describe, expect, it } from "vitest";
import { AgentState, TerminalState } from "@bazhen/protocol";
import { coreFixture } from "./core-fixtures.ts";

const files = coreFixture();
const text = (name: string) => files[name] ?? "null";

interface Row {
  from: string;
  final: boolean;
  events: readonly { event: string; to?: string; refused?: string }[];
}

const machines: Record<string, readonly Row[]> = JSON.parse(text("machines.json"));
const byName = (a: string, b: string) => a.localeCompare(b);
/** Each machine's events, and those of them some state takes. */
const eventsOf = Object.values(machines).map((rows) => ({
  listed: (rows[0]?.events ?? []).map((e) => e.event).toSorted(byName),
  taken: [
    ...new Set(rows.flatMap((r) => r.events.filter((e) => e.to !== undefined).map((e) => e.event))),
  ].toSorted(byName),
  finals: rows.map((r) => [r.final, r.events.every((e) => e.to === undefined)]),
}));
const mail: { leading: readonly { id: string | null }[] } = JSON.parse(text("mail.json"));
const leading = mail.leading.map((l) => l.id === null);
const roles: { cases: readonly { name: string; problems: readonly unknown[] }[] } = JSON.parse(
  text("roles.json"),
);
const roleCases = roles.cases;
const commands: readonly { state: string }[] = JSON.parse(text("commands.json"));

describe("the core fixture", () => {
  it("writes the machines, the commands, the mail labels and the role cases", () => {
    expect(Object.keys(files).toSorted(byName)).toEqual([
      "commands.json",
      "machines.json",
      "mail.json",
      "roles.json",
    ]);
  });

  it("lists only events some state takes, and calls final the states that take none", () => {
    expect(eventsOf.map((m) => m.taken)).toEqual(eventsOf.map((m) => m.listed));
    expect(eventsOf.flatMap((m) => m.finals.filter(([a, b]) => a !== b))).toEqual([]);
  });

  it("names what a refused event was refused by", () => {
    const closed = machines.agent?.find((r) => r.from === "closed");
    expect(closed?.events.find((e) => e.event === "close.requested")?.refused).toBe(
      "agent session cannot handle close.requested while closed",
    );
  });

  it("offers commands for every agent state beside every terminal state, or none", () => {
    expect(commands).toHaveLength(
      AgentState.options.length * (TerminalState.options.length + 1) * 4,
    );
    expect(new Set(commands.map((r) => r.state))).toEqual(new Set(AgentState.options));
  });

  it("reads a label's id from some texts and refuses others", () => {
    expect(new Set(leading)).toEqual(new Set([true, false]));
  });

  it("has role cases that keep every file, and cases that skip more than one", () => {
    expect(new Set(roleCases.map((c) => c.name)).size).toBe(roleCases.length);
    expect(roleCases.map((c) => c.problems.length)).toContain(0);
    expect(Math.max(...roleCases.map((c) => c.problems.length))).toBeGreaterThan(1);
  });
});

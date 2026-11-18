import { describe, expect, it } from "vitest";
import type { LimitStop } from "@bazhen/core";
import type { Activity, Usage, UsageLimit } from "@bazhen/protocol";
import { Limits, mergeLimits } from "./limits.ts";

const NOW = new Date("2026-11-18T12:00:00.000Z");
const SOON = "2026-11-18T13:00:00.000Z";
const LATER = "2026-11-24T13:00:00.000Z";
const PAST = "2026-11-18T11:00:00.000Z";

const at = (observedAt: string, value: Activity["value"], detail?: string): Activity => ({
  value,
  source: "native",
  confidence: 1,
  observedAt,
  ...(detail === undefined ? {} : { detail }),
});
const stop = at("2026-11-18T11:59:00.000Z", "failed", "rate_limit");

/** A Limits over a store of agents' usage, starting with agent `a`'s, and what it records. */
function setup(limits?: UsageLimit[]) {
  const held = new Map<string, Usage>(limits === undefined ? [] : [["a", { limits }]]);
  const recorded: Activity[] = [];
  const gate = new Limits({
    usage: (agentId) => held.get(agentId),
    recordUsage: (agentId, usage) => {
      const same = JSON.stringify(held.get(agentId)) === JSON.stringify(usage);
      held.set(agentId, usage);
      return same ? null : 1;
    },
    record: (_, a) => recorded.push(a),
    now: () => NOW,
  });
  const report = (a: Activity, limit?: LimitStop) => gate.record("a", a, limit);
  const meter = (next: UsageLimit[]) => gate.recordUsage("a", { limits: next });
  return { gate, held, recorded, report, meter };
}

describe("Limits", () => {
  it("reads a rate limit's stop as limited, until the latest reset of the windows it has used up", () => {
    const s = setup([
      { window: "five_hour", usedPercent: 100, resetsAt: SOON },
      { window: "seven_day", usedPercent: 100, resetsAt: LATER },
      { window: "spend_limit", usedPercent: 50, resetsAt: "2026-12-01T00:00:00.000Z" },
    ]);
    s.report(stop, "rate");
    expect(s.recorded).toEqual([{ ...stop, value: "limited", resetsAt: LATER }]);
  });

  it("keeps a rate limit's stop failed while no window shows the account at its limit", () => {
    const s = setup([
      { window: "five_hour", usedPercent: 99.5, resetsAt: SOON },
      { window: "seven_day", usedPercent: 100, resetsAt: PAST },
    ]);
    s.report(stop, "rate");
    expect(s.recorded).toEqual([stop]);
  });

  it("reads a stop as limited once a later reading shows the window it used up", () => {
    const s = setup();
    s.report(stop, "rate");
    s.meter([{ window: "five_hour", usedPercent: 100, resetsAt: SOON }]);
    expect(s.recorded).toEqual([
      stop,
      { ...stop, value: "limited", observedAt: NOW.toISOString(), resetsAt: SOON },
    ]);
  });

  it("reads a usage limit the harness names as limited, with no reset while no window gives one", () => {
    const s = setup();
    const quota = at(stop.observedAt, "failed", "usageLimitExceeded");
    s.report(quota, "quota");
    s.meter([{ window: "codex.primary", usedPercent: 100 }]);
    s.meter([{ window: "codex.primary", usedPercent: 100, resetsAt: SOON }]);
    expect(s.recorded.map((a) => [a.value, a.resetsAt])).toEqual([
      ["limited", undefined],
      ["limited", undefined],
      ["limited", SOON],
    ]);
  });

  it("weighs a stop no more once the agent reports anything else", () => {
    const s = setup();
    s.report(stop, "rate");
    s.report(at(NOW.toISOString(), "working"));
    s.meter([{ window: "five_hour", usedPercent: 100, resetsAt: SOON }]);
    expect(s.recorded.map((a) => a.value)).toEqual(["failed", "working"]);
  });

  it("weighs a stop again only when the usage changed", () => {
    const s = setup();
    s.report(at(stop.observedAt, "failed", "usageLimitExceeded"), "quota");
    s.meter([{ window: "codex.primary", usedPercent: 100 }]);
    s.meter([{ window: "codex.primary", usedPercent: 100 }]);
    expect(s.recorded).toHaveLength(2);
  });

  it("gives an account's update to each agent on it, kept beside what else its usage holds", () => {
    const s = setup();
    const primary = { window: "codex.primary", usedPercent: 100, resetsAt: SOON };
    const secondary = { window: "codex.secondary", usedPercent: 20 };
    s.held.set("b", { model: "gpt", limits: [{ ...primary, usedPercent: 50 }, secondary] });
    s.report(at(stop.observedAt, "failed", "rateLimitExceeded"), "rate");
    s.gate.accountLimits(["a", "b"], [primary]);
    expect([s.held.get("a"), s.held.get("b"), s.recorded.map((a) => a.value)]).toEqual([
      { limits: [primary] },
      { model: "gpt", limits: [primary, secondary] },
      ["failed", "limited"],
    ]);
  });

  it("records an activity with no limit mark as it came", () => {
    const s = setup([{ window: "five_hour", usedPercent: 100, resetsAt: SOON }]);
    s.report(stop);
    expect(s.recorded).toEqual([stop]);
  });
});

describe("mergeLimits", () => {
  it("replaces the windows an update names and keeps those it leaves out", () => {
    const primary = { window: "codex.primary", usedPercent: 10 };
    const secondary = { window: "codex.secondary", usedPercent: 40, resetsAt: LATER };
    expect([
      mergeLimits(undefined, [primary]),
      mergeLimits([primary, secondary], [{ ...primary, usedPercent: 100, resetsAt: SOON }]),
    ]).toEqual([[primary], [{ ...primary, usedPercent: 100, resetsAt: SOON }, secondary]]);
  });
});

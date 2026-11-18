import { describe, expect, it } from "vitest";
import type { LimitStop } from "@bazhen/core";
import { USAGE_LIMITS_MAX, type Activity, type Usage, type UsageLimit } from "@bazhen/protocol";
import { LATE_READING_MS, Limits, mergeLimits } from "./limits.ts";

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
const quota = at(stop.observedAt, "failed", "usageLimitExceeded");

/** A Limits over a store of agents' usage, starting with agent `a`'s, and what it records. */
function setup(limits?: UsageLimit[]) {
  const held = new Map<string, Usage>(limits === undefined ? [] : [["a", { limits }]]);
  const recorded: Activity[] = [];
  const gone = new Set<string>();
  const clock = { now: NOW };
  const gate = new Limits({
    usage: (agentId) => held.get(agentId),
    recordUsage: (agentId, usage) => {
      const same = JSON.stringify(held.get(agentId)) === JSON.stringify(usage);
      held.set(agentId, usage);
      return same ? null : 1;
    },
    record: (agentId, a) => (gone.has(agentId) ? null : recorded.push(a)),
    now: () => clock.now,
  });
  const report = (a: Activity, limit?: LimitStop) => gate.record("a", a, limit);
  const meter = (next: UsageLimit[]) => gate.recordUsage("a", { limits: next });
  return { gate, held, recorded, gone, clock, report, meter };
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
    s.report(quota, "quota");
    s.meter([{ window: "codex.primary", usedPercent: 100, resetsAt: SOON }]);
    expect(s.recorded.map((a) => [a.value, a.resetsAt])).toEqual([
      ["limited", undefined],
      ["limited", SOON],
    ]);
  });

  it("leaves a limited stop as it stands when a later reading shows no window used up", () => {
    const s = setup([{ window: "codex.primary", usedPercent: 100, resetsAt: SOON }]);
    s.report(quota, "quota");
    s.meter([{ window: "codex.primary", usedPercent: 2, resetsAt: LATER }]);
    expect(s.recorded).toEqual([{ ...quota, value: "limited", resetsAt: SOON }]);
  });

  it("counts no window at its limit that gives no reset, as one left stale would", () => {
    const s = setup([{ window: "primary", usedPercent: 100 }]);
    s.report(stop, "rate");
    expect(s.recorded).toEqual([stop]);
  });

  it("forgets an agent's stop once its process has gone, and no other agent's", () => {
    const s = setup();
    const reactors: ((e: { type: string; entityId: string }) => void)[] = [];
    s.gate.follow((reactor) => {
      reactors.push(reactor);
      return () => undefined;
    });
    const used = [{ window: "five_hour", usedPercent: 100, resetsAt: SOON }];
    s.gate.record("b", stop, "rate");
    for (const type of ["agent.exited", "agent.lost", "agent.closing"]) {
      s.gate.record(type, stop, "rate");
      for (const react of reactors) react({ type, entityId: type });
      s.gate.recordUsage(type, { limits: used });
    }
    s.gate.recordUsage("b", { limits: used });
    expect(s.recorded.map((a) => a.value)).toEqual([
      "failed",
      "failed",
      "failed",
      "failed",
      "limited",
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
    s.report(quota, "quota");
    s.meter([{ window: "codex.primary", usedPercent: 100, resetsAt: SOON }]);
    s.meter([{ window: "codex.primary", usedPercent: 100, resetsAt: SOON }]);
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

  it("weighs a stop again only for a reading soon after it, not one of the account hours on", () => {
    const s = setup();
    s.report(stop, "rate");
    s.clock.now = new Date(NOW.getTime() + LATE_READING_MS);
    s.meter([{ window: "five_hour", usedPercent: 100, resetsAt: LATER }]);
    s.clock.now = new Date(NOW.getTime() + LATE_READING_MS + 1);
    s.meter([{ window: "five_hour", usedPercent: 100, resetsAt: "2026-11-25T13:00:00.000Z" }]);
    expect(s.recorded.map((a) => [a.value, a.resetsAt])).toEqual([
      ["failed", undefined],
      ["limited", LATER],
    ]);
  });

  it("holds no stop the store didn't record, as for an agent whose process has gone", () => {
    const s = setup();
    s.gone.add("a");
    s.report(stop, "rate");
    s.gone.delete("a");
    s.meter([{ window: "five_hour", usedPercent: 100, resetsAt: SOON }]);
    expect(s.recorded).toEqual([]);
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

  it("keeps no more windows than usage holds, the first an update names when it alone names more", () => {
    const update = Array.from({ length: USAGE_LIMITS_MAX + 5 }, (_, i) => ({
      window: `w${i}`,
      usedPercent: i,
    }));
    const held = [{ window: `w${USAGE_LIMITS_MAX + 4}`, usedPercent: 1 }];
    expect(mergeLimits(held, update).map((l) => l.window)).toEqual(
      update.slice(0, USAGE_LIMITS_MAX).map((l) => l.window),
    );
  });

  it("holds a window an update names twice once, as it last names it", () => {
    const first = { window: "codex.primary", usedPercent: 10 };
    const again = { window: "codex.primary", usedPercent: 12, resetsAt: SOON };
    expect([mergeLimits(undefined, [first, again]), mergeLimits([first], [first, again])]).toEqual([
      [again],
      [again],
    ]);
  });

  it("keeps no more windows than usage holds, dropping first the oldest the update didn't name", () => {
    const held = Array.from({ length: USAGE_LIMITS_MAX }, (_, i) => ({
      window: `w${i}`,
      usedPercent: i,
    }));
    const merged = mergeLimits(held, [
      { window: "new", usedPercent: 1 },
      { ...held[5]!, usedPercent: 99 },
    ]);
    expect([
      merged.length,
      merged[0]?.window,
      merged.at(-1)?.window,
      merged.find((l) => l.window === "w5")?.usedPercent,
    ]).toEqual([USAGE_LIMITS_MAX, "w1", "new", 99]);
  });
});

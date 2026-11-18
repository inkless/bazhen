import { describe, expect, it } from "vitest";
import { handTimer } from "../testing/fixtures.ts";
import { until, type Judged } from "./until.ts";

/** Commits a test makes by hand, and the listeners set on them. */
function commits() {
  const listeners = new Set<() => void>();
  const store = {
    onCommit: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const commit = () => {
    for (const listener of listeners) listener();
  };
  return { store, commit, listeners };
}

/** A judge of a count a test moves, final once it reaches `at`; throws on `fail`. */
function counter(at: number, fail?: number) {
  const seen = { n: 0 };
  const judge = (): Judged<number> => {
    if (seen.n === fail) throw new Error(`judged ${fail}`);
    return { final: seen.n >= at, value: seen.n };
  };
  return { seen, judge };
}

describe("until", () => {
  it("answers a judgement final at once without listening, as one with no time to wait", async () => {
    const { store, listeners } = commits();
    const timer = handTimer();
    const signal = new AbortController().signal;
    const met = until(store, counter(0).judge, 60_000, signal, timer.after);
    const now = until(store, counter(1).judge, 0, signal, timer.after);
    expect([await met, await now, listeners.size, timer.pending.size]).toEqual([0, 0, 0, 0]);
  });

  it("judges again on each commit, answering on the first final one", async () => {
    const { store, commit, listeners } = commits();
    const timer = handTimer();
    const { seen, judge } = counter(2);
    const waited = until(store, judge, 60_000, new AbortController().signal, timer.after);
    seen.n = 1;
    commit();
    seen.n = 2;
    commit();
    expect([await waited, listeners.size, timer.pending.size]).toEqual([2, 0, 0]);
  });

  it("answers an abort with a judgement made then, holding nothing after", async () => {
    const { store, listeners } = commits();
    const timer = handTimer();
    const { seen, judge } = counter(9);
    const stop = new AbortController();
    const waited = until(store, judge, 60_000, stop.signal, timer.after);
    seen.n = 3;
    stop.abort();
    expect([await waited, listeners.size, timer.pending.size]).toEqual([3, 0, 0]);
  });

  it("rejects when a judgement after a commit throws, and stops listening", async () => {
    const { store, commit, listeners } = commits();
    const timer = handTimer();
    const { seen, judge } = counter(9, 1);
    const waited = until(store, judge, 60_000, new AbortController().signal, timer.after);
    seen.n = 1;
    commit();
    await expect(waited).rejects.toThrow("judged 1");
    expect([listeners.size, timer.pending.size]).toEqual([0, 0]);
  });
});

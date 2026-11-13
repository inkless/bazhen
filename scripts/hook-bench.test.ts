import { describe, expect, it } from "vitest";
import { failure, inconclusive, judge, overloaded } from "./hook-bench.ts";

/** `n` pairs: a floor of 3 ms and a client of 6 ms, each run slowed by what `load` adds to it. */
function pairs(n: number, load: (i: number) => { floor: number; client: number }) {
  const floor: number[] = [];
  const client: number[] = [];
  for (let i = 0; i < n; i++) {
    floor.push(3 + load(i).floor);
    client.push(6 + load(i).client);
  }
  return { floor, client };
}

const CLEAN = { floor: 0, client: 0 };
/** Every pair slowed by load but the 18th, and the client's runs slowed most. */
const allButOneSlowed = (i: number) => (i === 17 ? CLEAN : { floor: 2, client: 12 });
/** A client 40 ms slower in all but every tenth run, as a retry most hooks take would make it. */
const slowInMostRuns = (i: number) => (i % 10 === 0 ? CLEAN : { floor: 0, client: 40 });
/** A client 25 ms over every run, and the first pair's floor slowed by 22 ms. */
const slowBesideSlowedFloor = (i: number) =>
  i === 0 ? { floor: 22, client: 20 } : { floor: 0, client: 25 };

const healthy = (n: number) => pairs(n, () => CLEAN);
const slow = (n: number) => pairs(n, () => ({ floor: 0, client: 20 }));

describe("judge", () => {
  it("passes a healthy client whose runs were nearly all slowed by load", () => {
    const busy = pairs(40, allButOneSlowed);
    expect(judge(busy)).toMatchObject({ overheadMs: 3, typicalOverheadMs: 13, withinBudget: true });
  });

  it("fails a client slow in most runs, however quick its fastest", () => {
    expect(judge(pairs(40, slowInMostRuns))).toMatchObject({ overheadMs: 3, withinBudget: false });
  });

  it("fails a client over budget in every run", () => {
    expect(judge(slow(40))).toMatchObject({ overheadMs: 23, withinBudget: false });
  });

  it("fails a client over budget even beside a floor run that load slowed", () => {
    // Pair 0's difference is 26 - 25 = 1 ms; the client is never under 26 ms.
    expect(judge(pairs(40, slowBesideSlowedFloor)).withinBudget).toBe(false);
  });

  it("reports the spread of each side beside the verdict", () => {
    const client = [10, 3, 8, 1, 6, 9, 2, 7, 5, 4];
    const v = judge({ floor: client.map(() => 1), client });
    expect(v.client).toEqual({ minMs: 1, medianMs: 5, p90Ms: 9 });
    expect(v.pairs).toBe(10);
  });
});

describe("conclusive", () => {
  const limits = { minPairs: 40, maxPairs: 200 };

  it("takes no verdict before the minimum pairs, however good they look", () => {
    expect(judge(healthy(39), limits).conclusive).toBe(false);
  });

  it("stops at the minimum for a client within budget", () => {
    expect(judge(healthy(40), limits).conclusive).toBe(true);
  });

  it("keeps timing a client over budget until the maximum", () => {
    expect([judge(slow(40), limits).conclusive, judge(slow(200), limits).conclusive]).toEqual([
      false,
      true,
    ]);
  });
});

describe("failure", () => {
  it("fails a client the deadline cut short, even within budget so far", () => {
    expect(failure(judge(healthy(5)))).toMatch(/inconclusive$/);
  });

  it("passes a client within budget over the minimum pairs", () => {
    expect(failure(judge(healthy(40)))).toBeUndefined();
  });
});

describe("inconclusive", () => {
  it("excuses a developer machine too slow to settle the verdict", () => {
    expect(inconclusive(judge(healthy(5)), {})).toMatch(/^no verdict in 75 s: /);
  });

  it("never excuses CI", () => {
    expect(inconclusive(judge(healthy(5)), { CI: "true" })).toBeUndefined();
  });

  it("excuses no settled verdict", () => {
    expect(inconclusive(judge(slow(200)), {})).toBeUndefined();
  });
});

describe("overloaded", () => {
  it("excuses a developer machine running more work than it has cores", () => {
    expect(overloaded({}, 12.5, 8)).toBe("load average 12.5 exceeds 8 cores");
  });

  it("times a machine within its cores", () => {
    expect(overloaded({}, 7.9, 8)).toBeUndefined();
  });

  it("never excuses CI, however loaded", () => {
    expect(overloaded({ CI: "true" }, 40, 2)).toBeUndefined();
  });
});

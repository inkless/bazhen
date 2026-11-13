import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BINARY, BUDGET_MS, failure, inconclusive, measure, overloaded } from "./hook-bench.ts";

describe("hook client latency", () => {
  it(`adds under ${BUDGET_MS} ms over a bare sh -c true`, async ({ skip }) => {
    const reason = overloaded();
    skip(reason !== undefined, reason);
    const verdict = await measure(BINARY);
    const excuse = inconclusive(verdict);
    skip(excuse !== undefined, excuse);
    expect(failure(verdict)).toBeUndefined();
  });

  it("catches a client over budget", async () => {
    const dir = mkdtempSync("/tmp/bz-bench-");
    const slow = join(dir, "slow");
    writeFileSync(slow, `#!/bin/sh\nsleep 0.02\nexec ${BINARY} "$@"\n`, { mode: 0o755 });
    try {
      const verdict = await measure(slow, { minPairs: 5, maxPairs: 20 });
      expect(verdict.withinBudget).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

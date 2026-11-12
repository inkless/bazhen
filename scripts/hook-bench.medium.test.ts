import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BINARY, BUDGET_MS, measure } from "./hook-bench.ts";

describe("hook client latency", () => {
  it(`adds under ${BUDGET_MS} ms over a bare sh -c true`, async () => {
    const { overheadMs } = await measure(BINARY);
    expect(overheadMs).toBeLessThan(BUDGET_MS);
  });

  it("catches a client over budget", async () => {
    const dir = mkdtempSync("/tmp/bz-bench-");
    const slow = join(dir, "slow");
    writeFileSync(slow, `#!/bin/sh\nsleep 0.02\nexec ${BINARY} "$@"\n`, { mode: 0o755 });
    try {
      expect((await measure(slow, 5)).overheadMs).toBeGreaterThanOrEqual(BUDGET_MS);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

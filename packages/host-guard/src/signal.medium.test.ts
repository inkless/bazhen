import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { isAlive, runBounded, signalGroup, signalPane, spawnGroup, vouch } from "./signal.ts";

describe("signalling a group this process started", () => {
  it("reaches the child and the process it started, then finds them gone", async () => {
    const child = spawnGroup("sh", ["-c", "sleep 300 & echo $!; wait"], { stdio: "pipe" });
    const [line]: unknown[] = await once(child.stdout!, "data");
    const grandchild = Number(String(line).trim());
    expect([isAlive(child.pid!), isAlive(grandchild)]).toEqual([true, true]);
    signalGroup(child, "SIGTERM");
    await expect.poll(() => [isAlive(child.pid!), isAlive(grandchild)]).toEqual([false, false]);
  });
});

describe("a pane proof", () => {
  it("signals once, then is refused", async () => {
    const child = spawnGroup("sleep", ["300"], { stdio: "ignore" });
    const proof = vouch({ pid: child.pid!, server: "/tmp/bz-x/s", pane: "%1", generation: "0" });
    signalPane(proof, "SIGTERM");
    await expect.poll(() => isAlive(child.pid!)).toBe(false);
    expect(() => signalPane(proof, "SIGTERM")).toThrow("unvouched");
  });
});

describe("a bounded run", () => {
  it("tells a command that succeeded, failed or can't start apart", async () => {
    const outcomes = await Promise.all([
      runBounded("true", [], { timeoutMs: 5_000 }),
      runBounded("false", [], { timeoutMs: 5_000 }),
      runBounded("/nonexistent/bz-command", [], { timeoutMs: 5_000 }),
    ]);
    expect(outcomes).toEqual(["ok", "failed", "missing"]);
  });

  it("gives up on a command that outlives its time, and kills it", async () => {
    const started = Date.now();
    const outcome = await runBounded("sh", ["-c", "sleep 300 & wait"], { timeoutMs: 200 });
    expect([outcome, Date.now() - started < 5_000]).toEqual(["timed_out", true]);
  });
});

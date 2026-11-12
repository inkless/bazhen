import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { isAlive, signalGroup, spawnGroup } from "./signal.ts";

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

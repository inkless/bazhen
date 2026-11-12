import { describe, expect, it } from "vitest";
import { Settle } from "./settle.ts";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function counting(quietMs: number, maxWaitMs: number) {
  let fired = 0;
  const settle = new Settle(quietMs, maxWaitMs, () => fired++);
  return { settle, fired: () => fired };
}

describe("settling a burst of activity", () => {
  it("fires once, after the activity has been quiet for a while", async () => {
    const { settle, fired } = counting(100, 1000);
    settle.poke();
    await sleep(60);
    settle.poke();
    await sleep(60);
    const whileStillRecent = fired();
    await sleep(100);
    expect([whileStillRecent, fired()]).toEqual([0, 1]);
  });

  it("fires during activity that never goes quiet, no later than the longest wait", async () => {
    const { settle, fired } = counting(30, 80);
    for (let i = 0; i < 12; i++) {
      settle.poke();
      await sleep(10);
    }
    expect(fired()).toBeGreaterThanOrEqual(1);
    settle.dispose();
  });

  it("never fires once disposed", async () => {
    const { settle, fired } = counting(10, 20);
    settle.poke();
    settle.dispose();
    await sleep(40);
    expect(fired()).toBe(0);
  });
});

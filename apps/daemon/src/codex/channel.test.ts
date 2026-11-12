import { describe, expect, it } from "vitest";
import { nextDelay } from "./channel.ts";

describe("the wait before reconnecting to Codex", () => {
  it("doubles after each failure, up to a minute", () => {
    let wait = 1000;
    const waits = [wait];
    for (let i = 0; i < 8; i++) waits.push((wait = nextDelay(wait, null, 1000)));
    expect(waits).toEqual([1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });

  it("keeps growing after a connection that dropped at once, and starts again after one that held", () => {
    expect([nextDelay(4000, 200, 1000), nextDelay(4000, 30_000, 1000)]).toEqual([8000, 1000]);
  });
});

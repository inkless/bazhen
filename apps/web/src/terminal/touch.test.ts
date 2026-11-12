import { describe, expect, it } from "vitest";
import { ScrollSteps } from "./touch.ts";

describe("scroll steps from travel", () => {
  it("makes one step per row of travel, carrying the remainder to the next move", () => {
    const steps = new ScrollSteps();
    expect([steps.add(15, 20), steps.add(10, 20), steps.add(-45, 20)]).toEqual([0, 1, -2]);
  });

  it("forgets travel left over from an earlier gesture", () => {
    const steps = new ScrollSteps();
    steps.add(15, 20);
    steps.reset();
    expect(steps.add(10, 20)).toBe(0);
  });
});

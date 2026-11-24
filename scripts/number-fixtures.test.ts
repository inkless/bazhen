import { describe, expect, it } from "vitest";
import { isTie, numberFixture } from "./number-fixtures.ts";

const files = numberFixture();
const cases: readonly { bits: string; text: string; tie: boolean }[] = JSON.parse(
  files["cases.json"] ?? "[]",
);

describe("the number fixture", () => {
  it("writes only the cases", () => {
    expect(Object.keys(files)).toEqual(["cases.json"]);
  });

  it("tells a tie, whose exact decimal is a 5 past its shortest digits, from what isn't one", () => {
    expect(
      [20.005_508_422_851_562_5, 76.162_506_103_515_63, 0.5, 0.125, 0.1, 0].map(isTie),
    ).toEqual([true, true, false, false, false, false]);
  });

  it("records hundreds of ties among its numbers, each by its bits", () => {
    expect(cases.filter((c) => c.tie).length).toBeGreaterThanOrEqual(300);
    expect(cases.every((c) => /^[0-9a-f]{16}$/.test(c.bits))).toBe(true);
  });

  it("records the same numbers on every run", () => {
    expect(numberFixture()).toEqual(files);
  });
});

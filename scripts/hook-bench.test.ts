import { describe, expect, it } from "vitest";
import { overloaded } from "./hook-bench.ts";

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

import { describe, expect, it } from "vitest";
import { Id } from "./ids.ts";

describe("Id", () => {
  it("accepts a prefixed UUIDv7 and rejects any other well-formed hex", () => {
    expect([
      Id("term").safeParse("term_019a7b2c3d4e7f00a1b2c3d4e5f60718").success,
      Id("term").safeParse(`term_${"0".repeat(32)}`).success,
    ]).toEqual([true, false]);
  });

  it("rejects an id with another prefix", () => {
    expect(Id("agent").safeParse("term_019a7b2c3d4e7f00a1b2c3d4e5f60718").success).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { nextRequestId } from "./request-ids.ts";

const none = () => false;

describe("nextRequestId", () => {
  it("counts up from the id before it", () => {
    expect(nextRequestId(41, none)).toBe(42);
  });

  it("wraps past the largest u32 to 0", () => {
    expect(nextRequestId(0xffff_ffff, none)).toBe(0);
  });

  it("skips ids still waiting for an answer, across the wrap", () => {
    const waiting = new Set([0xffff_ffff, 0, 1]);
    expect(nextRequestId(0xffff_fffe, (id) => waiting.has(id))).toBe(2);
  });
});

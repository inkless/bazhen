import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  refusingOwnProto,
  utf8AtMost1024Bytes,
  utf8AtMost32Bytes,
  utf8AtMost64Bytes,
} from "./checks.ts";

describe("the checks the Rust schema names", () => {
  it.each([
    [utf8AtMost32Bytes, 32],
    [utf8AtMost64Bytes, 64],
    [utf8AtMost1024Bytes, 1024],
  ])("counts UTF-8 bytes, not characters, up to the budget", (check, max) => {
    expect(check("a".repeat(max))).toBe(true);
    expect(check("a".repeat(max + 1))).toBe(false);
    expect(check("é".repeat(max / 2))).toBe(true);
    expect(check(`${"é".repeat(max / 2)}a`)).toBe(false);
  });

  it("refuses a lone surrogate, which has no UTF-8, and takes a pair", () => {
    expect(utf8AtMost32Bytes("\ud83d")).toBe(false);
    expect(utf8AtMost32Bytes("\ud83d\ude00")).toBe(true);
  });

  it("refuses an own __proto__ key a record would skip, and nothing else", () => {
    const record = z.preprocess(refusingOwnProto, z.record(z.string(), z.string()));
    expect(
      z.record(z.string(), z.string()).safeParse(JSON.parse('{"__proto__":"x"}')).success,
    ).toBe(true);
    expect(record.safeParse(JSON.parse('{"__proto__":"x"}')).success).toBe(false);
    expect(record.safeParse({ a: "x", constructor: "y" }).success).toBe(true);
  });
});

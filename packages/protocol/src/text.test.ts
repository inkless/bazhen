import { describe, expect, it } from "vitest";
import { showable, whole } from "./text.ts";

const ok = (code: number) => showable(`a${String.fromCharCode(code)}b`);

describe("showable", () => {
  it("refuses every C0 and C1 control and each bidirectional override and isolate", () => {
    const refused = [
      0x00, 0x09, 0x0a, 0x1b, 0x1f, 0x7f, 0x80, 0x9b, 0x9f, 0x202a, 0x202e, 0x2066, 0x2069,
    ];
    const shown = [0x20, 0x7e, 0xa0, 0x2029, 0x202f, 0x2065, 0x206a];
    expect([refused.filter(ok), shown.filter((c) => !ok(c))]).toEqual([[], []]);
  });

  it("lets through only the controls it is told to", () => {
    const allow = new Set([0x0a]);
    expect([showable("a\nb", allow), showable("a\tb", allow), showable("a\nb")]).toEqual([
      true,
      false,
      false,
    ]);
  });
});

describe("whole", () => {
  it("cuts to at most so many UTF-16 units, never through a surrogate pair", () => {
    const name = `${"x".repeat(63)}👍`;
    expect([whole(name, 64), whole(name, 65), whole("ab👍c", 4), whole("abc", 2)]).toEqual([
      "x".repeat(63),
      name,
      "ab👍",
      "ab",
    ]);
    expect(JSON.stringify(whole(name, 64))).not.toContain("\\ud83d");
  });
});

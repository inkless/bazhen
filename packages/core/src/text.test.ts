import { describe, expect, it } from "vitest";
import { whole } from "./text.ts";

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

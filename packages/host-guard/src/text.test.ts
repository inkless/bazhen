import { describe, expect, it } from "vitest";
import { whole } from "./text.ts";

describe("whole", () => {
  it("cuts to at most so many UTF-16 units, never through a surrogate pair", () => {
    expect([whole("ab👍", 3), whole("ab👍", 4), whole("ab👍c", 4), whole("abc", 2)]).toEqual([
      "ab",
      "ab👍",
      "ab👍",
      "ab",
    ]);
  });
});

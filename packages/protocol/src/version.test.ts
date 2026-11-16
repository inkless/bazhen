import { describe, expect, it } from "vitest";
import { isCompatible } from "./version.ts";

describe("protocol version compatibility", () => {
  it("accepts a peer on the same major with a different minor", () => {
    expect(isCompatible("1.7", "1.0")).toBe(true);
  });

  it("rejects a peer on a different major", () => {
    expect(isCompatible("2.0", "1.0")).toBe(false);
  });

  it("rejects a malformed version instead of comparing its prefix", () => {
    expect(isCompatible("1", "1.0")).toBe(false);
    expect(isCompatible("1.0-beta", "1.0")).toBe(false);
  });
});

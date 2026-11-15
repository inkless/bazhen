import { describe, expect, it } from "vitest";
import { inSignalSandbox } from "./sandbox.ts";

describe("the signal sandbox", () => {
  it("is a host carrying root's marker", () => {
    expect(inSignalSandbox({ markerOwner: 0 })).toBe(true);
  });

  it("isn't a host without the marker, or whose marker someone else made", () => {
    expect(inSignalSandbox({ markerOwner: undefined })).toBe(false);
    expect(inSignalSandbox({ markerOwner: 1000 })).toBe(false);
  });
});

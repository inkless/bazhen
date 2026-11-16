import { describe, expect, it } from "vitest";
import { isAnotherBuild } from "./build.ts";

const OURS = "a".repeat(64);

describe("isAnotherBuild", () => {
  it("is false for a daemon speaking this page's protocol", () => {
    expect(isAnotherBuild({ status: "ok", protocolId: OURS }, OURS)).toBe(false);
  });

  it("is true for a daemon speaking another, or naming none, as one from before ids", () => {
    expect([
      isAnotherBuild({ status: "ok", protocolId: "b".repeat(64) }, OURS),
      isAnotherBuild({ status: "ok", protocolVersion: "1.53" }, OURS),
    ]).toEqual([true, true]);
  });
});

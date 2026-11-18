import { describe, expect, it } from "vitest";
import { isoOfUnixSeconds } from "./unix-time.ts";

describe("isoOfUnixSeconds", () => {
  it("reads a harness's Unix seconds as an ISO time, and anything a Date can't hold as none", () => {
    expect(
      [1_795_006_800, 8.64e12, 8.64e12 + 1, 0, -5, 1.5, "1795006800", null].map(isoOfUnixSeconds),
    ).toEqual([
      "2026-11-18T13:00:00.000Z",
      "+275760-09-13T00:00:00.000Z",
      null,
      null,
      null,
      null,
      null,
      null,
    ]);
  });
});

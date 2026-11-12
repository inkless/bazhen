import { describe, expect, it } from "vitest";
import { drift } from "./protocol-schema.ts";

describe("schema drift", () => {
  it("is empty when the committed files match the export", () => {
    expect(drift({ "A.json": "{}" }, { "A.json": "{}" })).toEqual([]);
  });

  it("names files that are stale, missing or no longer exported", () => {
    const expected = { "A.json": "{ new }", "B.json": "{}" };
    const committed = { "A.json": "{ old }", "C.json": "{}" };
    expect(drift(expected, committed)).toEqual(["A.json", "B.json", "C.json"]);
  });
});

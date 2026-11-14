import { describe, expect, it } from "vitest";
import { drift, fixtureHash, frozenFailures } from "./protocol-schema.ts";

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

describe("frozen holder fixtures", () => {
  const files = { "frames.json": "[1]" };
  const pin = fixtureHash(files);

  it("pass when every older version matches its pin, the current one unpinned", () => {
    expect(
      frozenFailures({ "1.0": files, "1.1": { "frames.json": "[2]" } }, "1.1", { "1.0": pin }),
    ).toEqual([]);
  });

  it("name an older version with no pin, with the pin to add", () => {
    expect(frozenFailures({ "1.0": files, "1.1": {} }, "1.1", {})).toEqual([
      `fixtures/holder/1.0/ is frozen: pin "1.0": "${pin}" in FROZEN_HOLDER_FIXTURES.`,
    ]);
  });

  it("name an older version edited, renamed or dropped after it was pinned", () => {
    expect([
      frozenFailures({ "1.0": { "frames.json": "[1, 2]" } }, "1.1", { "1.0": pin }),
      frozenFailures({ "1.0": { "frames2.json": "[1]" } }, "1.1", { "1.0": pin }),
      frozenFailures({ "1.0": {} }, "1.1", { "1.0": pin }),
      frozenFailures({ "1.1": {} }, "1.1", { "1.0": pin }),
    ]).toEqual([
      ["fixtures/holder/1.0/ was changed after it froze."],
      ["fixtures/holder/1.0/ was changed after it froze."],
      ["fixtures/holder/1.0/ was changed after it froze."],
      ["fixtures/holder/1.0/ is pinned but gone."],
    ]);
  });
});

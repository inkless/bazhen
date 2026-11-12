import { describe, expect, it } from "vitest";
import { parseJson } from "./json.ts";

describe("JSON from a peer", () => {
  it("is undefined when it isn't JSON, rather than an exception", () => {
    expect([parseJson('{"type":"engage"}'), parseJson("{not json")]).toEqual([
      { type: "engage" },
      undefined,
    ]);
  });
});

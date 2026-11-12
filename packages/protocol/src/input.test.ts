import { describe, expect, it } from "vitest";
import { parseJson, withoutEventReports } from "./input.ts";

const ESC = "\x1b";

describe("a view's input without its event reports", () => {
  it.each([
    ["focus in", `${ESC}[I`],
    ["focus out", `${ESC}[O`],
    ["an SGR wheel", `${ESC}[<65;10;5M`],
    ["an SGR release", `${ESC}[<0;10;5m`],
    ["a urxvt report", `${ESC}[96;10;5M`],
    ["an X10 report", `${ESC}[Ma*%`],
  ])("leaves nothing of %s", (_name, report) => {
    expect(withoutEventReports(report)).toBe("");
  });

  it("keeps what was typed around a report", () => {
    expect(withoutEventReports(`a${ESC}[Ib${ESC}[A`)).toBe(`ab${ESC}[A`);
  });
});

describe("JSON from a peer", () => {
  it("is undefined when it isn't JSON, rather than an exception", () => {
    expect([parseJson('{"type":"engage"}'), parseJson("{not json")]).toEqual([
      { type: "engage" },
      undefined,
    ]);
  });
});

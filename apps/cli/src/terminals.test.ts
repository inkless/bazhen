import { describe, expect, it } from "vitest";
import { terminalLines } from "./terminals.ts";

describe("what doctor says about terminals", () => {
  it("shows the open count against the budget, and the machine's PTYs", () => {
    expect(
      terminalLines({ open: 3, max: 100, host: { used: 37, max: 4096, exact: true } }),
    ).toEqual([
      "terminals: 3 open, at most 100 (terminals.max_open)",
      "  machine PTYs: 37 of 4096 in use",
    ]);
  });

  it("says new terminals are refused once the budget is reached", () => {
    expect(terminalLines({ open: 4, max: 4, host: null })).toEqual([
      "terminals: 4 open, at most 4 (terminals.max_open)",
      "  new agents and shells are refused until one is closed",
      "  machine PTYs: can't be counted here",
    ]);
  });

  it("calls an approximate count of the machine's PTYs an upper bound", () => {
    expect(terminalLines({ open: 1, max: 4, host: { used: 40, max: 511, exact: false } })).toEqual([
      "terminals: 1 open, at most 4 (terminals.max_open)",
      "  machine PTYs: as many as 40 of 511 in use (the count includes closed ones)",
    ]);
  });
});

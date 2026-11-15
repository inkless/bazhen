import { describe, expect, it } from "vitest";
import type { HostPtys } from "@bazhen/host-guard";
import { TerminalBudget, TerminalLimit, hostHeadroom } from "./budget.ts";

const roomy: HostPtys = { ok: true, used: 10, max: 4096, exact: true };

function budget({ max = 3, open = 0, host = roomy } = {}) {
  const state: { open: number; host: HostPtys } = { open, host };
  const warnings: string[] = [];
  const b = new TerminalBudget({
    max,
    open: () => state.open,
    host: () => state.host,
    warn: (m) => warnings.push(m),
  });
  return { b, state, warnings };
}

const refusal = (admit: () => void): TerminalLimit => {
  try {
    admit();
  } catch (err) {
    if (err instanceof TerminalLimit) return err;
    throw err;
  }
  throw new Error("admitted");
};

/** A host with exactly `free` PTYs left after one more opens. */
const leaving = (free: number, exact: boolean): HostPtys => ({
  ok: true,
  used: 511 - 1 - free,
  max: 511,
  exact,
});

describe("TerminalBudget", () => {
  it("admits a terminal while fewer than the budget are open", () => {
    expect(() => budget({ max: 3, open: 2 }).b.admit()).not.toThrow();
  });

  it("refuses one at the budget, saying how many are open and what to do", () => {
    const err = refusal(() => budget({ max: 3, open: 3 }).b.admit());
    expect({ open: err.open, max: err.max, host: err.host, message: err.message }).toEqual({
      open: 3,
      max: 3,
      host: false,
      message:
        "3 terminals are open, the most at once (terminals.max_open = 3): close one you no longer need to open another",
    });
  });

  it("refuses one above a budget lowered below what is open", () => {
    expect(refusal(() => budget({ max: 2, open: 5 }).b.admit()).open).toBe(5);
  });

  it("admits again once a terminal has ended", () => {
    const { b, state } = budget({ max: 1, open: 1 });
    refusal(() => b.admit());
    state.open = 0;
    expect(() => b.admit()).not.toThrow();
  });

  it("keeps PTYs free for the rest of the machine: a tenth of them, and never fewer than 16", () => {
    expect([hostHeadroom(4096), hostHeadroom(511), hostHeadroom(100)]).toEqual([410, 52, 16]);
  });

  it("refuses on an exact count that would leave the machine less than its headroom", () => {
    const err = refusal(() => budget({ host: leaving(hostHeadroom(511) - 1, true) }).b.admit());
    expect({ host: err.host, message: err.message }).toEqual({
      host: true,
      message:
        "the machine has 459 of 511 PTYs in use, and Bazhen keeps 52 free for the rest of the system: close a terminal, or raise the machine's PTY limit",
    });
  });

  it("admits on an exact count that leaves the machine exactly its headroom", () => {
    expect(() => budget({ host: leaving(hostHeadroom(511), true) }).b.admit()).not.toThrow();
  });

  it("only warns, once while short, on an approximate count that would pass the headroom", () => {
    const short = leaving(hostHeadroom(511) - 1, false);
    const { b, state, warnings } = budget({ host: short });
    b.admit();
    b.admit();
    state.host = roomy;
    b.admit();
    state.host = short;
    b.admit();
    expect(warnings).toEqual([
      expect.stringContaining("may have as many as 459 of 511 PTYs in use"),
      expect.stringContaining("may have as many as 459 of 511 PTYs in use"),
    ]);
  });

  it("still enforces the budget when the machine's PTYs can't be counted, saying so once", () => {
    const { b, state, warnings } = budget({ max: 2, host: { ok: false, reason: "no /proc" } });
    b.admit();
    b.admit();
    state.open = 2;
    refusal(() => b.admit());
    expect(warnings).toEqual([
      "the machine's PTYs can't be counted (no /proc): only terminals.max_open limits new terminals",
    ]);
  });

  it("warns at start about terminals kept above the budget and a budget above the machine's PTYs", () => {
    const host: HostPtys = { ok: true, used: 10, max: 50, exact: true };
    expect(budget({ max: 64, open: 70, host }).b.startupWarnings()).toEqual([
      "70 terminals are open, above terminals.max_open (64): they keep running, and new ones are refused until fewer than 64 are open",
      "terminals.max_open (64) is above the machine's 50 PTYs: the machine's own limit is reached first",
    ]);
  });

  it("says nothing at start at or under the budget, on a machine with room for it", () => {
    expect(budget({ max: 3, open: 3 }).b.startupWarnings()).toEqual([]);
  });

  it("reports the count, the budget and the machine for doctor, the machine null when unread", () => {
    const unread = budget({ open: 1, host: { ok: false, reason: "x" } }).b.report();
    expect([budget({ open: 2 }).b.report(), unread]).toEqual([
      { open: 2, max: 3, host: { used: 10, max: 4096, exact: true } },
      { open: 1, max: 3, host: null },
    ]);
  });
});

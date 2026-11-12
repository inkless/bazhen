import { describe, expect, it } from "vitest";
import { exitStatus, UnknownCause } from "./exit-status.ts";

describe("exitStatus", () => {
  it("reads an exit code", () => {
    expect(exitStatus("3", "")).toEqual({ type: "exited", code: 3 });
  });

  it.each(["term", "TERM", "15"])("names the signal tmux printed as %j SIGTERM", (raw) => {
    expect(exitStatus("", raw)).toEqual({ type: "signalled", signal: "SIGTERM" });
  });

  it("prefers a signal's canonical name to its aliases", () => {
    expect(exitStatus("", "6")).toEqual({ type: "signalled", signal: "SIGABRT" });
  });

  it("calls a death with neither a code nor a signal unknown", () => {
    expect(exitStatus("", "")).toEqual({ type: "unknown" });
  });
});

const exits = (rows: { exit: unknown }[]) => rows.map((r) => r.exit);

describe("UnknownCause", () => {
  const unknown = { key: "a", exit: { type: "unknown" } as const };

  it("reads a death of unknown cause as running until the grace runs out", () => {
    const grace = new UnknownCause(2000);
    expect([0, 1999, 2000].flatMap((t) => exits(grace.settle([unknown], t)))).toEqual([
      null,
      null,
      { type: "unknown" },
    ]);
  });

  it("starts the grace again for a terminal that was not dead in between", () => {
    const grace = new UnknownCause(2000);
    grace.settle([unknown], 0);
    grace.settle([], 1000);
    expect(exits(grace.settle([unknown], 2500))).toEqual([null]);
  });

  it("passes a known cause straight through", () => {
    const exited = { key: "a", exit: { type: "exited", code: 1 } as const };
    expect(new UnknownCause(2000).settle([exited], 0)).toEqual([exited]);
  });
});

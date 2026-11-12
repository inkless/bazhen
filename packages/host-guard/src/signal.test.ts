import { describe, expect, it } from "vitest";
import { isAlive, signalGroup, signalPane } from "./signal.ts";

describe("the signal guard", () => {
  it("refuses a group it did not start", () => {
    expect(() => signalGroup({ pid: 4242 }, "SIGTERM")).toThrow("not started here");
  });

  it("refuses a pane no tmux server vouched for", () => {
    expect(() => signalPane({ pid: 4242 }, "SIGTERM")).toThrow("unvouched");
  });

  it("refuses to probe init, every process, or a group", () => {
    for (const pid of [1, 0, -1, -4242, 1.5]) expect(() => isAlive(pid)).toThrow(RangeError);
  });
});

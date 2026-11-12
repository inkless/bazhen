import { describe, expect, it } from "vitest";
import { isAlive, signalGroup, signalPane, vouch } from "./signal.ts";

const pane = { pid: 4242, server: "/tmp/bz-x/s", pane: "%1", generation: "0" };

describe("the signal guard", () => {
  it("refuses a group it did not start", () => {
    expect(() => signalGroup({ pid: 4242 }, "SIGTERM")).toThrow("not started here");
  });

  it("refuses a pane no tmux server vouched for", () => {
    expect(() => signalPane(pane, "SIGTERM")).toThrow("unvouched");
  });

  it("refuses a proof older than a second, before anything is sent", () => {
    const proof = vouch(pane, 0);
    expect(() => signalPane(proof, "SIGTERM", 1_001)).toThrow("stale proof");
  });

  it("refuses to probe init, every process, or a group", () => {
    for (const pid of [1, 0, -1, -4242, 1.5]) expect(() => isAlive(pid)).toThrow(RangeError);
  });
});

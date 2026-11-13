import { describe, expect, it } from "vitest";
import { isAlive, signalGroup, signalPane, signalServer, vouch, vouchServer } from "./signal.ts";

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

describe("the tmux server signal guard", () => {
  // Above every system's pid limit, so even a broken guard reaches no process.
  const server = { pid: 2 ** 22 + 1, socket: "/tmp/bz-x/s" };

  it("refuses a server no check vouched for", () => {
    expect(() => signalServer(server)).toThrow("unvouched");
  });

  it("refuses to signal a server on a proof older than a second", () => {
    const proof = vouchServer(server, 0);
    expect(() => signalServer(proof, 1_001)).toThrow("stale proof");
  });

  it("refuses a proof presented once already, even a refused one, without sending", () => {
    const proof = vouchServer(server, 0);
    expect(() => signalServer(proof, 1_001)).toThrow("stale proof");
    expect(() => signalServer(proof, 0)).toThrow("unvouched");
  });

  it("refuses a hand-made copy of a proof", () => {
    const proof = vouchServer(server, 0);
    expect(() => signalServer({ ...proof }, 0)).toThrow("unvouched");
  });

  it("refuses to vouch for init, every process, or a group", () => {
    for (const pid of [1, 0, -1, -4242, 1.5])
      expect(() => vouchServer({ ...server, pid })).toThrow(RangeError);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  isAlive,
  killHolder,
  signalGroup,
  signalPane,
  signalServer,
  unsafeTarget,
  vouch,
  vouchHolderProcess,
  vouchServer,
} from "./signal.ts";

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

describe("the target every signal is checked against", () => {
  const self = 5_000;
  const parent = 4_000;
  const group = 3_000;
  const refused = (target: number) => unsafeTarget(target, self, parent, group);

  it("refuses init, every process, and this process's own group", () => {
    for (const target of [0, -0, 1, -1])
      expect(refused(target)).toBe("not a single process or group");
  });

  it("refuses this process and its group, and its parent and its group", () => {
    expect([refused(self), refused(-self)]).toEqual(["this process", "this process"]);
    expect([refused(parent), refused(-parent)]).toEqual([
      "this process's parent",
      "this process's parent",
    ]);
  });

  it("refuses this process's group, which ends the whole run it is in", () => {
    expect([refused(-group), refused(group)]).toEqual([
      "this process's group",
      "this process's group",
    ]);
  });

  it("refuses every group while this process's own can't be read, but not a single process", () => {
    expect([
      unsafeTarget(-4242, self, parent, Number.NaN),
      unsafeTarget(4242, self, parent, Number.NaN),
    ]).toEqual(["this process's group is unknown", undefined]);
  });

  it("refuses what isn't a pid", () => {
    for (const target of [Number.NaN, 1.5, -2.5, Infinity, -Infinity, 2 ** 53])
      expect(refused(target)).toBe("not a pid");
  });

  it("allows another process or group", () => {
    for (const target of [2, -2, self + 1, -(parent - 1), -(group + 1)])
      expect(refused(target)).toBeUndefined();
  });

  it("defaults to this process and its parent", () => {
    expect([unsafeTarget(process.pid), unsafeTarget(-process.ppid)]).toEqual([
      "this process",
      "this process's parent",
    ]);
  });
});

describe("a proof for this process or its parent", () => {
  afterEach(() => vi.restoreAllMocks());

  // A proof checks only that a pid is above 1, so these reach the send itself, whose refusal is
  // all that stands between them and the test runner. Stubbed, so a broken refusal sends nothing.
  it("is refused at the send, with nothing sent", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    expect(() => killHolder(vouchHolderProcess({ pid: process.ppid, start: 0 }))).toThrow(
      "this process's parent",
    );
    expect(() => signalServer(vouchServer({ pid: process.pid, socket: "/tmp/bz-x/s" }))).toThrow(
      "this process",
    );
    expect(kill).not.toHaveBeenCalled();
  });
});

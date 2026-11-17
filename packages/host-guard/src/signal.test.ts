import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import {
  groupInPs,
  groupInStat,
  isAlive,
  killHolder,
  killHolderAt,
  PROOF_MS,
  rebindHolder,
  rebindHolderAt,
  signalGroup,
  signalOwnChild,
  signalPane,
  signalPaneAt,
  signalServer,
  signalServerAt,
  unsafeTarget,
  vouch,
  vouchAt,
  vouchHolderProcess,
  vouchHolderProcessAt,
  vouchServer,
  vouchServerAt,
  type HolderProcess,
  type HolderUse,
  type PaneGroup,
  type ServerProcess,
} from "./signal.ts";

// Above every system's pid limit, so even a broken guard reaches no process.
const pane = { pid: 2 ** 22 + 1, server: "/tmp/bz-x/s", pane: "%1", generation: "0" };

describe("the signal guard", () => {
  it("refuses a group it did not start", () => {
    expect(() => signalGroup({ pid: pane.pid }, "SIGTERM")).toThrow("not started here");
  });

  it("refuses a pane no tmux server vouched for", () => {
    expect(() => signalPane(pane, "SIGTERM")).toThrow("unvouched");
  });

  it("refuses a proof older than a second, before anything is sent", () => {
    const proof = vouchAt(pane, 0);
    expect(() => signalPaneAt(proof, "SIGTERM", PROOF_MS + 1)).toThrow("stale proof");
  });

  it("refuses a proof spent before it was made, as a clock set back would have it", () => {
    const proof = vouchAt(pane, 5_000);
    expect(() => signalPaneAt(proof, "SIGTERM", 4_999)).toThrow("stale proof");
  });

  it("refuses to probe init, every process, or a group", () => {
    for (const pid of [1, 0, -1, -4242, 1.5]) expect(() => isAlive(pid)).toThrow(RangeError);
  });
});

/** A child as Node holds it, ended or not, that records each signal sent and reaches nothing. */
const ownChild = (exitCode: number | null, signalCode: NodeJS.Signals | null) => {
  const sent: (NodeJS.Signals | undefined)[] = [];
  return {
    sent,
    child: { exitCode, signalCode, kill: (signal?: NodeJS.Signals) => (sent.push(signal), true) },
  };
};

describe("the guard on a child this process spawned", () => {
  it("signals one still running through its own handle", () => {
    const { child, sent } = ownChild(null, null);
    expect([signalOwnChild(child, "SIGKILL"), sent]).toEqual([true, ["SIGKILL"]]);
  });

  it.each([
    ["exited", 0, null],
    ["was killed", null, "SIGKILL"],
  ] as const)("sends nothing to one that %s, whose pid may be another's now", (_, code, signal) => {
    const { child, sent } = ownChild(code, signal);
    expect([signalOwnChild(child, "SIGKILL"), sent]).toEqual([false, []]);
  });
});

describe("the tmux server signal guard", () => {
  // Above every system's pid limit, so even a broken guard reaches no process.
  const server = { pid: 2 ** 22 + 1, socket: "/tmp/bz-x/s" };

  it("refuses a server no check vouched for", () => {
    expect(() => signalServer(server)).toThrow("unvouched");
  });

  it("refuses to signal a server on a proof older than a second", () => {
    const proof = vouchServerAt(server, 0);
    expect(() => signalServerAt(proof, PROOF_MS + 1)).toThrow("stale proof");
  });

  it("refuses to signal a server on a proof spent before it was made", () => {
    const proof = vouchServerAt(server, 5_000);
    expect(() => signalServerAt(proof, 4_999)).toThrow("stale proof");
  });

  it("refuses a proof presented once already, even a refused one, without sending", () => {
    const proof = vouchServerAt(server, 0);
    expect(() => signalServerAt(proof, PROOF_MS + 1)).toThrow("stale proof");
    expect(() => signalServerAt(proof, 0)).toThrow("unvouched");
  });

  it("refuses a hand-made copy of a proof", () => {
    const proof = vouchServerAt(server, 0);
    expect(() => signalServerAt({ ...proof }, 0)).toThrow("unvouched");
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
    expect(() => killHolder(vouchHolderProcess({ pid: process.ppid, start: 0 }, "kill"))).toThrow(
      "this process's parent",
    );
    expect(() => signalServer(vouchServer({ pid: process.pid, socket: "/tmp/bz-x/s" }))).toThrow(
      "this process",
    );
    expect(() =>
      rebindHolder(vouchHolderProcess({ pid: process.ppid, start: 0 }, "rebind")),
    ).toThrow("this process's parent");
    expect(kill).not.toHaveBeenCalled();
  });
});

describe("reading this process's group", () => {
  it("reads the fifth field of a stat line, past a command holding spaces and parentheses", () => {
    expect(groupInStat("4242 (node (x) y) S 4000 3000 3000 0 -1")).toBe(3000);
  });

  it("reads nothing, 0 or 1 as unknown, so the floor refuses every group", () => {
    expect(
      [
        groupInStat("4242 (node) S 4000 0 0"),
        groupInStat(""),
        groupInPs(""),
        groupInPs("  1\n"),
      ].map(Number.isNaN),
    ).toEqual([true, true, true, true]);
    expect(groupInPs(" 3000\n")).toBe(3000);
  });
});

describe("a holder proof's age", () => {
  // Above every system's pid limit, so even a broken guard reaches no process.
  const holder = { pid: 2 ** 22 + 1, start: 0 };

  it("refuses a kill proof spent before it was made or after its second", () => {
    expect(() => killHolderAt(vouchHolderProcessAt(holder, "kill", 5_000), 4_999)).toThrow(
      "stale proof",
    );
    expect(() => killHolderAt(vouchHolderProcessAt(holder, "kill", 0), PROOF_MS + 1)).toThrow(
      "stale proof",
    );
  });

  it("refuses a rebind proof spent before it was made or after its second", () => {
    expect(() => rebindHolderAt(vouchHolderProcessAt(holder, "rebind", 5_000), 4_999)).toThrow(
      "stale proof",
    );
    expect(() => rebindHolderAt(vouchHolderProcessAt(holder, "rebind", 0), PROOF_MS + 1)).toThrow(
      "stale proof",
    );
  });
});

describe("the forms product code calls", () => {
  afterEach(() => vi.restoreAllMocks());

  // The types refuse a time, but a caller can still be typed to pass one; it must change nothing.
  // Stubbed, so the send each proof reaches sends nothing.
  it("judge a proof by their own clock, whatever time their caller hands them", () => {
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);
    const vouchWithTime: (group: PaneGroup, now: number) => PaneGroup = vouch;
    const signalWithTime: (pane: PaneGroup, signal: NodeJS.Signals, now: number) => void =
      signalPane;
    signalPane(vouchWithTime(pane, Number.MIN_SAFE_INTEGER), "SIGTERM");
    signalWithTime(vouch(pane), "SIGTERM", Number.MAX_SAFE_INTEGER);
    expect(kill.mock.calls).toEqual([
      [-pane.pid, "SIGTERM"],
      [-pane.pid, "SIGTERM"],
    ]);

    expectTypeOf(vouch).parameters.toEqualTypeOf<[PaneGroup]>();
    expectTypeOf(signalPane).parameters.toEqualTypeOf<[PaneGroup, NodeJS.Signals]>();
    expectTypeOf(vouchServer).parameters.toEqualTypeOf<[ServerProcess]>();
    expectTypeOf(signalServer).parameters.toEqualTypeOf<[ServerProcess]>();
    expectTypeOf(vouchHolderProcess).parameters.toEqualTypeOf<[HolderProcess, HolderUse]>();
    expectTypeOf(killHolder).parameters.toEqualTypeOf<[HolderProcess]>();
    expectTypeOf(rebindHolder).parameters.toEqualTypeOf<[HolderProcess]>();
  });
});

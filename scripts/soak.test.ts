import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATE } from "./soak-judge.ts";
import {
  attachMarkers,
  closedUnder,
  leastFds,
  main,
  parseSoakArgs,
  profile,
  type Profile,
  windowEnd,
  ptyMasters,
  outliving,
  screenOf,
  sleepUntil,
  splitAtCursor,
  type Viewing,
  watch,
} from "./soak.ts";
import { marker } from "./soak-worker.ts";

const SIZE = { cols: 40, rows: 5 };
const HOUR = 3_600_000;
const bytes = (text: string) => Buffer.from(text, "utf8");
/** What a terminal's output processing makes of a worker's writes: each CR LF is CR CR LF. */
const pty = (text: string) => text.replaceAll("\r\n", "\r\r\n");
/** How often `p` restarts the daemon; zero for one that never does. */
const restartEvery = (p: Profile) => p.restart?.everyMs ?? 0;

const PID = 7;
/** How long the daemon's once-a-second poll of every holder keeps their connections open. */
const BURST_MS = 5;
/**
 * A process at `steady` fds but for one connection per holder, 25 of them, during the first
 * `BURST_MS` of every second, read on a clock that only the reads' sleeps move. It starts in a burst.
 */
function polled(steady: number) {
  let now = 0;
  return {
    use: () => ({ fds: now % 1_000 < BURST_MS ? steady + 25 : steady, ptys: 0 }),
    sleep: (ms: number) => {
      now += ms;
      return Promise.resolve();
    },
  };
}
/** Park–Miller: the same sequence in [0, 1) every run. */
function seeded(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 48_271) % 2_147_483_647;
    return state / 2_147_483_647;
  };
}
/** The fds `leastFds` reports for a polled process at `steady`, once for each of `runs`. */
async function leastOfPolled(steady: number, random: () => number, runs: number) {
  const reported: (number | undefined)[] = [];
  for (let run = 0; run < runs; run++) {
    const fds = await leastFds([PID], 5, { ...polled(steady), random });
    reported.push(fds.get(PID)?.fds);
  }
  return reported;
}

describe("profile", () => {
  it("runs the gate's load at §12.4's rates, judged on the gate's bars over the hours asked", () => {
    const gate = profile("gate", 24);
    expect(gate.load).toEqual({ replay: 15, flood: 5, idle: 3, echo: 1 });
    expect([gate.warmupMs, gate.restart?.everyMs, gate.agentCycleEveryMs]).toEqual([
      HOUR,
      600_000,
      300_000,
    ]);
    expect(gate.judge).toEqual({ ...GATE, minMeasuredMs: 24 * HOUR });
  });

  it("runs the long life as the gate does, but never restarts the daemon and judges its one life", () => {
    const long = profile("long-life", 72);
    expect(long).toMatchObject({
      name: "long-life",
      hours: 72,
      warmupMs: HOUR,
      measureMs: 72 * HOUR,
      restart: null,
      agentCycleEveryMs: 300_000,
      idleChurnEveryMs: 60_000,
      sampleEveryMs: 30_000,
      load: { replay: 15, flood: 5, idle: 3, echo: 1 },
    });
    expect(long.judge).toEqual({
      ...GATE,
      minMeasuredMs: 72 * HOUR,
      daemon: { lives: "one" },
      churnEveryMs: { agent: 300_000, idle: 60_000 },
    });
  });

  it("runs the smoke's same load faster, leaving what only hours show unmeasured", () => {
    const smoke = profile("smoke", 0.2);
    expect(smoke.load).toEqual(profile("gate", 24).load);
    expect(smoke.measureMs).toBe(0.2 * HOUR);
    expect(smoke.judge.requireAll).toBe(false);
    expect(smoke.judge.slopeWindowMs).toBeGreaterThan(smoke.measureMs);
  });

  it("judges echo in the smoke run only against a broken path, the gate's bar being a dedicated host's", () => {
    expect(profile("smoke", 0.2).judge.echoP99Ms).toBeGreaterThan(GATE.echoP99Ms * 5);
    expect(profile("gate", 24).judge.echoP99Ms).toBe(GATE.echoP99Ms);
  });

  it("takes four settled samples a daemon life: a warm-up, a baseline and two held to it", () => {
    for (const p of [profile("gate", 24), profile("smoke", 0.2)]) {
      expect(restartEvery(p) / p.settleEveryMs).toBeGreaterThanOrEqual(4);
    }
  });

  it("asks for twice the seams its bar needs, since a seam is kept only when output pauses", () => {
    for (const p of [profile("gate", 24), profile("long-life", 24), profile("smoke", 0.2)]) {
      expect(HOUR / p.seamEveryMs).toBeGreaterThanOrEqual(2 * p.judge.seamsPerHour);
    }
  });

  it("judges the churn at the cadence it runs", () => {
    for (const p of [profile("gate", 24), profile("smoke", 0.2)]) {
      expect(p.judge.churnEveryMs).toEqual({
        restart: restartEvery(p),
        agent: p.agentCycleEveryMs,
        idle: p.idleChurnEveryMs,
      });
    }
    const long = profile("long-life", 24);
    expect(long.judge.churnEveryMs).toEqual({
      agent: long.agentCycleEveryMs,
      idle: long.idleChurnEveryMs,
    });
  });

  it("churns idle shells no faster than each can be checked twice before it closes", () => {
    const smoke = profile("smoke", 0.2);
    expect(smoke.idleChurnEveryMs * smoke.load.idle).toBeGreaterThan(30_000);
  });
});

describe("windowEnd", () => {
  it("ends the window no sooner than asked, however early it is recorded", () => {
    expect(windowEnd(1_000, HOUR, 1_000 + HOUR - 1, false)).toBe(1_000 + HOUR);
    expect(windowEnd(1_000, HOUR, 1_000 + HOUR + 7, false)).toBe(1_000 + HOUR + 7);
  });

  it("ends the window when the daemon died, short of what was asked", () => {
    expect(windowEnd(1_000, HOUR, 1_000 + HOUR / 2, true)).toBe(1_000 + HOUR / 2);
  });
});

describe("parseSoakArgs", () => {
  const now = new Date("2026-11-16T10:00:00.000Z");

  it("runs the gate for a day by default, into a directory named for when it started", () => {
    const parsed = parseSoakArgs([], now);
    expect(parsed).toMatchObject({ faults: [], profile: { name: "gate", hours: 24 } });
    expect(parsed).toHaveProperty(
      "out",
      expect.stringMatching(/soak-gate-2026-11-16T10-00-00-000Z$/),
    );
  });

  it("takes a profile, hours, a directory and faults to inject", () => {
    expect(
      parseSoakArgs(
        ["--profile", "smoke", "--hours", "0.1", "--out", "/r", "--fault", "close-holder"],
        now,
      ),
    ).toMatchObject({
      out: "/r",
      faults: ["close-holder"],
      profile: { name: "smoke", hours: 0.1 },
    });
  });

  it("runs the long life for a day by default", () => {
    expect(parseSoakArgs(["--profile", "long-life"], now)).toMatchObject({
      profile: { name: "long-life", hours: 24 },
      out: expect.stringMatching(/soak-long-life-2026-11-16T10-00-00-000Z$/),
    });
  });

  it("judges a finished run's directory again", () => {
    expect(parseSoakArgs(["--judge", "/r"])).toEqual({ judge: "/r" });
  });

  it("refuses an unknown profile or fault, hours that aren't positive, and a stray argument", () => {
    expect(() => parseSoakArgs(["--profile", "week"])).toThrow(/no profile week/);
    expect(() => parseSoakArgs(["--fault", "oom"])).toThrow(/no fault oom/);
    expect(() => parseSoakArgs(["--hours", "0"])).toThrow(/positive/);
    expect(() => parseSoakArgs(["now"])).toThrow(/usage/);
  });
});

describe("splitAtCursor", () => {
  it("gives the whole lines above the cursor's, and its line up to the cursor", async () => {
    const split = await splitAtCursor(bytes("one\r\ntwo\r\n#soak r1 4"), SIZE);
    expect(split).toEqual({ above: "one\ntwo\n", line: "#soak r1 4" });
  });

  it("keeps a space the cursor stands after, and reaches into scrollback", async () => {
    const lines = Array.from({ length: 12 }, (_, i) => `l${i}\r\n`).join("");
    const split = await splitAtCursor(bytes(`${lines}#soak r1 `), SIZE);
    expect(split.above.split("\n").slice(0, 2)).toEqual(["l0", "l1"]);
    expect(split.line).toBe("#soak r1 ");
  });
});

describe("attachMarkers", () => {
  it("reads a marker the snapshot cut short as the stream's, so the seam holds no gap", async () => {
    const snapshot = pty(`${marker("r1", 40)}${marker("r1", 41)}#soak r1 4`);
    const stream = pty(`2\r\n${marker("r1", 43)}`);
    expect(await attachMarkers("r1", bytes(snapshot), bytes(stream), SIZE)).toEqual({
      snapshot: [[40, 41]],
      stream: [[42, 43]],
    });
  });

  it("reads a marker the snapshot cut between its CR and its LF once, as the stream's", async () => {
    const snapshot = pty(`${marker("f2", 7)}${marker("f2", 8)}`).slice(0, -2);
    const stream = `\r\n${pty(marker("f2", 9))}`;
    expect(await attachMarkers("f2", bytes(snapshot), bytes(stream), SIZE)).toEqual({
      snapshot: [[7, 7]],
      stream: [[8, 9]],
    });
  });

  it("reads markers the snapshot drew past its visible screen", async () => {
    const snapshot = pty(Array.from({ length: 9 }, (_, i) => marker("f1", i + 1)).join(""));
    const seen = await attachMarkers("f1", bytes(snapshot), bytes(""), SIZE);
    expect(seen.snapshot).toEqual([[1, 9]]);
  });
});

describe("screenOf", () => {
  it("is the same for bytes that draw the same screen, and differs by a cell or the cursor", async () => {
    const drawn = await screenOf(bytes("ab\r\ncd"), SIZE);
    expect(await screenOf(bytes("xb\r\ncd\x1b[1;1Ha\x1b[2;3H"), SIZE)).toBe(drawn);
    expect(await screenOf(bytes("ab\r\nce"), SIZE)).not.toBe(drawn);
    expect(await screenOf(bytes("ab\r\ncd\x1b[1;1H"), SIZE)).not.toBe(drawn);
  });
});

/**
 * A view whose snapshot arrives on its third look, moving `clock` from 1 000 to 5 000 as it does,
 * and to 9 000 once its snapshot is read, as the attach ends.
 */
function arrivingView(clock: { now: number }): Viewing {
  let looks = 0;
  return {
    hasSnapshot: () => {
      looks++;
      if (looks === 3) clock.now = 5_000;
      return looks >= 3;
    },
    snapshot: () => {
      clock.now = 9_000;
      return Buffer.from("snap");
    },
    received: () => Buffer.from("snapstream"),
  };
}

describe("watch", () => {
  it("times an attach when its snapshot had arrived, not when it began or ended", async () => {
    const clock = { now: 1_000 };
    const watched = await watch(arrivingView(clock), 10, () => clock.now);
    expect(watched).toEqual({
      t: 5_000,
      snapshot: Buffer.from("snap"),
      stream: Buffer.from("stream"),
    });
  });
});

describe("sleepUntil", () => {
  afterEach(() => vi.restoreAllMocks());

  it("asks for no wait, never a negative one, when the deadline has passed", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    await sleepUntil(1_000, () => 1_466);
    expect(timer.mock.calls.map(([, ms]) => ms)).toEqual([0]);
  });

  it("waits what is left until a deadline still to come", async () => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    await sleepUntil(1_010, () => 1_000);
    expect(timer.mock.calls.map(([, ms]) => ms)).toEqual([10]);
  });
});

describe("leastFds", () => {
  it("keeps a connection the daemon opens every second when its reads are a second apart", async () => {
    // The control: a random source stuck at the middle of its range gives gaps of exactly 1 s.
    expect(await leastOfPolled(34, () => 0.5, 1)).toEqual([59]);
  });

  it("drops a connection the daemon opens every second, reading at random phases of it", async () => {
    const reported = await leastOfPolled(34, seeded(1), 200);
    expect(reported.filter((fds) => fds !== 34)).toEqual([]);
  });

  it("still reports a leaked fd, which is open at every read", async () => {
    const reported = await leastOfPolled(35, seeded(1), 200);
    expect(reported.filter((fds) => fds !== 35)).toEqual([]);
  });

  it("keeps each read's fds, in the order read, so a reader can tell a burst from a leak", async () => {
    const fds = await leastFds([PID], 5, { ...polled(34), random: () => 0.5 });
    expect(fds.get(PID)?.reads).toEqual([59, 59, 59, 59, 59]);
    const spread = await leastFds([PID], 5, { ...polled(34), random: seeded(1) });
    expect(spread.get(PID)?.reads).toEqual([59, 34, 34, 34, 34]);
  });
});

describe("main", () => {
  it("refuses a run off a disposable host, before it starts anything", async () => {
    // Under a regular file, where no one, root included, can make the run's directory.
    const out = join(fileURLToPath(import.meta.url), "soak");
    await expect(main(["--profile", "smoke", "--out", out], false)).rejects.toThrow(
      /Refusing to run/,
    );
  });
});

describe("closedUnder", () => {
  it("skips a step that failed on a terminal the driver was closing", () => {
    expect(closedUnder({ closing: true }, new Error("connect ENOENT"))).toBe("skipped");
  });

  it("throws any other step's failure again, for the judge's churn", () => {
    const failure = new Error("timed out waiting for a view's snapshot");
    expect(() => closedUnder({}, failure)).toThrow(failure);
    expect(() => closedUnder({ closing: false }, failure)).toThrow(failure);
  });
});

describe("ptyMasters", () => {
  it("counts the PTY masters among what a process's fds name, at /dev/ptmx or a devpts mount's", () => {
    expect(
      ptyMasters([
        "/dev/ptmx",
        "/dev/pts/ptmx",
        "/dev/pts/3",
        "socket:[123]",
        "/tmp/bz-api-x/run/holders/term_1.log",
        "",
      ]),
    ).toBe(2);
  });
});

describe("outliving", () => {
  it("names each of a closed terminal's worker, shell and holder still alive, each once", () => {
    const alive = new Set([11, 33]);
    expect(outliving({ pid: 11, childPid: 22, holderPid: 33 }, (pid) => alive.has(pid))).toEqual([
      11, 33,
    ]);
    expect(outliving({ pid: 11, childPid: 11 }, (pid) => alive.has(pid))).toEqual([11]);
    expect(outliving({}, () => true)).toEqual([]);
  });
});

// Rows end at their last cell that isn't blank, and the cursor is placed by CUP.
const engine = (rows: string, row: number, column: number) =>
  `\x1b[H\x1b[2J${rows}\x1b[${row};${column}H`;

describe("splitAtCursor, on a snapshot as the holder engine writes it", () => {
  it("keeps the blank the cursor stands after, and the text right of it, as the stream may end it", async () => {
    const blank = await splitAtCursor(bytes(engine("one\r\n#soak f2", 2, 10)), SIZE);
    expect(blank).toEqual({ above: "one\n", line: "#soak f2 " });
    const right = await splitAtCursor(bytes(engine("one\r\n#soak f2 7", 2, 1)), SIZE);
    expect(right).toEqual({ above: "one\n", line: "#soak f2 7" });
    const full = "#soak f2 ".padEnd(SIZE.cols, "x");
    expect(await splitAtCursor(bytes(full), SIZE)).toEqual({ above: "", line: full });
  });

  it("reads a marker cut after its blank once, as the stream's", async () => {
    const snapshot = engine(`${marker("f2", 5355653360)}#soak f2`, 2, 10);
    const stream = pty(`5355653361\r\n${marker("f2", 5355653362)}`);
    expect(await attachMarkers("f2", bytes(snapshot), bytes(stream), SIZE)).toEqual({
      snapshot: [[5355653360, 5355653360]],
      stream: [[5355653361, 5355653362]],
    });
  });
});

import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { GATE } from "./soak-judge.ts";
import {
  attachMarkers,
  closedUnder,
  main,
  parseSoakArgs,
  profile,
  ptyMasters,
  outliving,
  screenOf,
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

describe("profile", () => {
  it("runs the gate's load at §12.4's rates, judged on the gate's bars over the hours asked", () => {
    const gate = profile("gate", 24);
    expect(gate.load).toEqual({ replay: 15, flood: 5, idle: 3, echo: 1 });
    expect([gate.warmupMs, gate.restartEveryMs, gate.agentCycleEveryMs]).toEqual([
      HOUR,
      600_000,
      300_000,
    ]);
    expect(gate.judge).toEqual({ ...GATE, minMeasuredMs: 24 * HOUR });
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
      expect(p.restartEveryMs / p.settleEveryMs).toBeGreaterThanOrEqual(4);
    }
  });

  it("asks for twice the seams its bar needs, since a seam is kept only when output pauses", () => {
    for (const p of [profile("gate", 24), profile("smoke", 0.2)]) {
      expect(HOUR / p.seamEveryMs).toBeGreaterThanOrEqual(2 * p.judge.seamsPerHour);
    }
  });

  it("judges the churn at the cadence it runs", () => {
    for (const p of [profile("gate", 24), profile("smoke", 0.2)]) {
      expect(p.judge.churnEveryMs).toEqual({
        restart: p.restartEveryMs,
        agent: p.agentCycleEveryMs,
        idle: p.idleChurnEveryMs,
      });
    }
  });

  it("churns idle shells no faster than each can be checked twice before it closes", () => {
    const smoke = profile("smoke", 0.2);
    expect(smoke.idleChurnEveryMs * smoke.load.idle).toBeGreaterThan(30_000);
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
      snapshot: [40, 41],
      stream: [42, 43],
    });
  });

  it("reads a marker the snapshot cut between its CR and its LF once, as the stream's", async () => {
    const snapshot = pty(`${marker("f2", 7)}${marker("f2", 8)}`).slice(0, -2);
    const stream = `\r\n${pty(marker("f2", 9))}`;
    expect(await attachMarkers("f2", bytes(snapshot), bytes(stream), SIZE)).toEqual({
      snapshot: [7],
      stream: [8, 9],
    });
  });

  it("reads markers the snapshot drew past its visible screen", async () => {
    const snapshot = pty(Array.from({ length: 9 }, (_, i) => marker("f1", i + 1)).join(""));
    const seen = await attachMarkers("f1", bytes(snapshot), bytes(""), SIZE);
    expect(seen.snapshot).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
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

import { describe, expect, it } from "vitest";
import {
  TEST_BINARY_CAP,
  exitStatus,
  formatDuration,
  parseArgs,
  parseDuration,
  parseSize,
  report,
} from "./capped.ts";

const GIB = 1024 ** 3;
const cap = { memory: 8 * GIB, timeMs: 20 * 60_000 };
const ended = {
  code: 0,
  signal: null,
  peak: 3 * GIB,
  memoryKills: 0,
  timedOut: false,
  leftover: 0,
};

describe("capped's arguments", () => {
  it("takes a command's caps and its whole argv", () => {
    expect(parseArgs(["--memory", "8G", "--time", "20m", "--", "vitest", "run", "--x"])).toEqual({
      kind: "run",
      cap,
      memoryKillsCounted: false,
      ownScope: false,
      command: "vitest",
      args: ["run", "--x"],
    });
  });

  it("gives a test binary the runner's cap, or a smaller memory cap it is given", () => {
    expect(parseArgs(["--test-binary", "--", "/t/deps/a-1f", "--list"])).toEqual({
      kind: "test-binary",
      cap: TEST_BINARY_CAP,
      memoryKillsCounted: false,
      ownScope: false,
      command: "/t/deps/a-1f",
      args: ["--list"],
    });
    expect(parseArgs(["--test-binary", "--memory", "128M", "--", "/t/a"])).toMatchObject({
      cap: { memory: 128 * 1024 ** 2, timeMs: TEST_BINARY_CAP.timeMs },
    });
    expect(() => parseArgs(["--test-binary", "--time", "1m", "--", "/t/a"])).toThrow("usage");
  });

  it("takes a run's word that it counts its memory kills, after its caps alone", () => {
    const counted = ["--memory", "8G", "--time", "20m", "--memory-kills-counted", "--", "x"];
    expect(parseArgs(counted)).toMatchObject({ kind: "run", memoryKillsCounted: true });
    const first = ["--memory-kills-counted", "--memory", "8G", "--time", "20m", "--", "x"];
    expect(() => parseArgs(first)).toThrow("usage");
    const binary = ["--test-binary", "--memory-kills-counted", "--", "/t/a"];
    expect(() => parseArgs(binary)).toThrow("usage");
  });

  it("takes a run's word that it wants a scope of its own, before its caps alone", () => {
    const own = ["--own-scope", "--memory", "8G", "--time", "20m", "--", "x"];
    expect(parseArgs(own)).toMatchObject({ kind: "run", cap, ownScope: true });
    expect(parseArgs([...own.slice(0, 5), "--memory-kills-counted", "--", "x"])).toMatchObject({
      ownScope: true,
      memoryKillsCounted: true,
    });
    const after = ["--memory", "8G", "--time", "20m", "--own-scope", "--", "x"];
    expect(() => parseArgs(after)).toThrow("usage");
    expect(() => parseArgs(["--own-scope", "--test-binary", "--", "/t/a"])).toThrow("usage");
    expect(() => parseArgs(["--test-binary", "--own-scope", "--", "/t/a"])).toThrow("usage");
  });

  it("drops the `--` pnpm hands on, but not one the command itself is given", () => {
    const run = parseArgs(["--memory", "8G", "--time", "2h", "--", "--", "cargo", "--", "x"]);
    expect(run).toMatchObject({ command: "cargo", args: ["--", "x"] });
  });

  it("refuses a run without both caps, or without a command", () => {
    expect(() => parseArgs(["--memory", "8G", "--", "vitest"])).toThrow("usage");
    expect(() => parseArgs(["--memory", "8G", "--time", "20m", "--"])).toThrow("usage");
    expect(() => parseArgs(["vitest", "run"])).toThrow("usage");
  });

  it("reads sizes and durations, and refuses a cap of nothing", () => {
    expect(parseSize("512M")).toBe(512 * 1024 ** 2);
    expect(parseDuration("90s")).toBe(90_000);
    expect(parseDuration("2h")).toBe(7_200_000);
    expect(() => parseSize("0G")).toThrow("memory cap");
    expect(() => parseSize("8GB")).toThrow("memory cap");
    expect(() => parseDuration("20")).toThrow("time cap");
  });
});

describe("what a run says when it ends", () => {
  it("gives a command's peak against its cap", () => {
    expect(report(ended, cap, "scope", false)).toEqual(["capped: peak 3.0 GiB of 8.0 GiB"]);
  });

  it("says a scope's kills were the memory cap's", () => {
    expect(report({ ...ended, memoryKills: 2 }, cap, "scope", false)).toContain(
      "capped: killed 2 process(es) at the 8.0 GiB memory cap",
    );
  });

  it("says a watchdog stopped the whole run", () => {
    expect(report({ ...ended, memoryKills: 1 }, cap, "watched", false)).toContain(
      "capped: stopped the run at the 8.0 GiB memory cap",
    );
  });

  it("names the time cap only when no memory kill explains the end", () => {
    expect(report({ ...ended, timedOut: true }, cap, "scope", false)).toContain(
      "capped: stopped at the 20 min time cap",
    );
    expect(report({ ...ended, timedOut: true, memoryKills: 1 }, cap, "scope", false)).toEqual([
      "capped: peak 3.0 GiB of 8.0 GiB",
      "capped: killed 1 process(es) at the 8.0 GiB memory cap",
    ]);
  });

  it("says when a memory kill may have gone uncounted, even for a test binary", () => {
    const why = "journalctl couldn't be read";
    const killed = { ...ended, code: null, signal: "SIGKILL" as const, uncounted: why };
    expect(report(killed, cap, "scope", true)).toEqual([`capped: ${why}`]);
  });

  it("keeps a test binary quiet unless a cap fired, and takes no SIGKILL for a memory kill", () => {
    expect(report(ended, cap, "scope", true)).toEqual([]);
    expect(report({ ...ended, code: null, signal: "SIGKILL" }, cap, "scope", true)).toEqual([]);
    expect(report({ ...ended, memoryKills: 1 }, cap, "owned", true)).toEqual([
      "capped: killed the test process at the 8.0 GiB memory cap",
    ]);
  });

  it("names the enclosing run's memory cap for a run through, and a kill by it", () => {
    expect(report(ended, cap, "through", false)).toEqual([
      "capped: under the enclosing run's 8.0 GiB memory cap",
    ]);
    expect(report({ ...ended, memoryKills: 1 }, cap, "through", true)).toEqual([
      "capped: killed by the enclosing run's 8.0 GiB memory cap",
    ]);
  });

  it("says how many processes a run's command left running, and a test binary doesn't", () => {
    expect(report({ ...ended, leftover: 2 }, cap, "scope", false)).toEqual([
      "capped: peak 3.0 GiB of 8.0 GiB",
      "capped: stopped 2 process(es) its command left running",
    ]);
    expect(report({ ...ended, leftover: 2 }, cap, "through", true)).toEqual([]);
  });

  it("names what a run's command left running, the most of one name first", () => {
    const left = ["sleep", "tmux", "bazhen-holder", "tmux"];
    expect(report({ ...ended, leftover: 4, left }, cap, "watched", false)).toEqual([
      "capped: peak 3.0 GiB of 8.0 GiB",
      "capped: stopped 4 process(es) its command left running: tmux ×2, bazhen-holder ×1, sleep ×1",
    ]);
  });

  it("escapes a name's control characters, so it can't forge a line", () => {
    const left = ["x\ncapped: a forged line", "tab\there", "rtl\u202Eexe.txt"];
    expect(report({ ...ended, leftover: 3, left }, cap, "scope", false)).toContain(
      "capped: stopped 3 process(es) its command left running: " +
        "rtl\\u{202e}exe.txt ×1, tab\\x09here ×1, x\\x0acapped: a forged line ×1",
    );
  });

  it("names the CPU-time limit when a test dies of it", () => {
    expect(report({ ...ended, code: null, signal: "SIGXCPU" }, cap, "owned", true)).toEqual([
      "capped: stopped at its CPU-time limit, set for a test whose runner had died",
    ]);
  });

  it("gives a short time cap in seconds", () => {
    expect(formatDuration(2_000)).toBe("2 s");
    expect(formatDuration(120 * 60_000)).toBe("120 min");
  });
});

const RUN = parseArgs(["--memory", "8G", "--time", "20m", "--", "vitest"]);
const COUNTING = { ...RUN, memoryKillsCounted: true };
const BINARY = parseArgs(["--test-binary", "--", "/t/a"]);

describe("how a run ends", () => {
  it("keeps a failed command's status, and a test binary's, whatever its caps did", () => {
    const fired = { ...ended, memoryKills: 1, timedOut: true, leftover: 1 };
    expect([
      exitStatus({ ...fired, code: 3 }, RUN),
      exitStatus({ ...fired, code: null, signal: "SIGKILL" }, RUN),
      exitStatus(fired, BINARY),
    ]).toEqual([{ status: 3 }, { status: "SIGKILL" }, { status: 0 }]);
  });

  it("fails a passed run on an uncounted memory kill, its time cap or a leftover", () => {
    expect([
      exitStatus({ ...ended, memoryKills: 1 }, RUN),
      exitStatus({ ...ended, memoryKills: 1 }, COUNTING),
      exitStatus({ ...ended, memoryKills: 1, timedOut: true }, COUNTING),
      exitStatus({ ...ended, memoryKills: 1, leftover: 1 }, COUNTING),
      exitStatus(ended, RUN),
    ]).toEqual([
      { status: 1, why: "its memory cap killed a process in it" },
      { status: 0 },
      { status: 1, why: "it reached its time cap" },
      { status: 1, why: "its command left processes running" },
      { status: 0 },
    ]);
  });
});

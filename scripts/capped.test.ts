import { describe, expect, it } from "vitest";
import {
  TEST_BINARY_CAP,
  formatDuration,
  parseArgs,
  parseDuration,
  parseSize,
  report,
} from "./capped.ts";

const GIB = 1024 ** 3;
const cap = { memory: 8 * GIB, timeMs: 20 * 60_000 };
const ended = { code: 0, signal: null, peak: 3 * GIB, memoryKills: 0, timedOut: false };

describe("capped's arguments", () => {
  it("takes a command's caps and its whole argv", () => {
    expect(parseArgs(["--memory", "8G", "--time", "20m", "--", "vitest", "run", "--x"])).toEqual({
      kind: "run",
      cap,
      command: "vitest",
      args: ["run", "--x"],
    });
  });

  it("gives a test binary the runner's cap, or a smaller memory cap it is given", () => {
    expect(parseArgs(["--test-binary", "--", "/t/deps/a-1f", "--list"])).toEqual({
      kind: "test-binary",
      cap: TEST_BINARY_CAP,
      command: "/t/deps/a-1f",
      args: ["--list"],
    });
    expect(parseArgs(["--test-binary", "--memory", "128M", "--", "/t/a"])).toMatchObject({
      cap: { memory: 128 * 1024 ** 2, timeMs: TEST_BINARY_CAP.timeMs },
    });
    expect(() => parseArgs(["--test-binary", "--time", "1m", "--", "/t/a"])).toThrow("usage");
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

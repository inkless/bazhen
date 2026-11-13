import { afterEach, describe, expect, it, vi } from "vitest";
import { parsePs, psAnswer, ranByPane, type ProcessEntry } from "./binding.ts";

afterEach(() => vi.restoreAllMocks());

/** A process table from pid → [ppid, command]. */
const table = (procs: Record<number, [number, string]>) => ({
  parent: async (pid: number): Promise<ProcessEntry | undefined> => {
    const p = procs[pid];
    return p === undefined ? undefined : { ppid: p[0], command: p[1] };
  },
});

describe("ranByPane", () => {
  it("accepts a hook the pane's process ran directly or through shells", async () => {
    const procs = table({ 300: [200, "/bin/sh"], 200: [100, "-zsh"] });
    expect(await ranByPane(procs, 100, 100)).toBe(true);
    expect(await ranByPane(procs, 300, 100)).toBe(true);
  });

  it("refuses a hook a nested claude ran, though the pane's process is further up", async () => {
    // hook → sh 500 → claude 400 (nested) → bash 300 (the agent's tool) → claude 100 (the pane)
    const procs = table({ 500: [400, "sh"], 400: [300, "claude"], 300: [100, "bash"] });
    expect(await ranByPane(procs, 500, 100)).toBe(false);
  });

  it("refuses when the walk can't read a process", async () => {
    expect(await ranByPane(table({}), 300, 100)).toBe(false);
  });

  it("walks through at most four processes, rather than up to init", async () => {
    const procs = table({ 6: [5, "sh"], 5: [4, "sh"], 4: [3, "sh"], 3: [2, "sh"], 2: [1, "sh"] });
    // The hook's parent and three shells above it are looked at: 6, 5, 4 and 3, never 2.
    expect([await ranByPane(procs, 6, 3), await ranByPane(procs, 6, 2)]).toEqual([true, false]);
  });
});

describe("psAnswer", () => {
  it("reads a process quietly", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(psAnswer(7, null, "1 claude\n")).toEqual({ ppid: 1, command: "claude" });
    expect(log).not.toHaveBeenCalled();
  });

  it("takes a process that has gone as gone, quietly", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(psAnswer(7, { code: 1, message: "exit 1" }, "")).toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });

  it("logs a ps that can't run or times out, and reads nothing from it", () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(psAnswer(7, { code: "ENOENT", message: "spawn ps ENOENT" }, "")).toBeUndefined();
    expect(psAnswer(7, { code: null, message: "killed" }, "")).toBeUndefined();
    expect(log).toHaveBeenCalledTimes(2);
    expect(String(log.mock.calls[0])).toContain("spawn ps ENOENT");
  });
});

describe("parsePs", () => {
  it("reads the parent pid and the whole command, spaces included", () => {
    expect(parsePs("  4242 /Applications/My App/claude\n")).toEqual({
      ppid: 4242,
      command: "/Applications/My App/claude",
    });
  });

  it("reads nothing from empty output, as for a process that has gone", () => {
    expect(parsePs("")).toBeUndefined();
  });
});

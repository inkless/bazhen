import { describe, expect, it } from "vitest";
import { isAlive } from "./signal.ts";
import { readProcess, terminalForeground, terminalGroups } from "./tmux.ts";

describe("what ps shows of a process", () => {
  it("reads this process's whole command, start and argument line", async () => {
    const started = Date.now() / 1000 - process.uptime();
    expect(await readProcess(process.pid)).toEqual({
      // Node's own name for its process differs by platform (`node`, or `MainThread` on Linux).
      comm: expect.stringMatching(/\S/),
      start: expect.toSatisfy((start: number) => Math.abs(start - started) <= 2),
      args: expect.stringContaining(String(process.argv[1])),
    });
  });

  it("finds a pid no process has absent", async () => {
    // Within every system's pid range (macOS's tops out at 99999), and free just now.
    const free = [...Array(1000).keys()].map((i) => 99_999 - i).find((pid) => !isAlive(pid));
    expect(await readProcess(Number(free))).toBe("absent");
  });
});

describe("a process's terminal foreground", () => {
  it("reads a process group for a live process, and absent for a pid no process has", async () => {
    const free = [...Array(1000).keys()].map((i) => 99_999 - i).find((pid) => !isAlive(pid));
    expect([
      typeof (await terminalForeground(process.pid)),
      await terminalForeground(Number(free)),
    ]).toEqual(["number", "absent"]);
  });
});

describe("many processes' foreground groups at once", () => {
  it("reads a group for each live process, and leaves out a pid no process has", async () => {
    const free = [...Array(1000).keys()].map((i) => 99_999 - i).find((pid) => !isAlive(pid));
    const read = await terminalGroups([process.pid, Number(free)]);
    expect(read).toEqual(new Map([[process.pid, expect.any(Number)]]));
  });

  it("is unreadable, never half read, when ps prints more than it may", async () => {
    expect(await terminalGroups([process.pid], 4)).toBe("unreadable");
  });
});

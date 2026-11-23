// Runs real allocators past small caps. Each allocator stops itself at 1 GiB, so a cap that fails
// to fire costs the run 1 GiB and a failed assertion, never the machine's memory.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  cappedScope,
  chooseMode,
  cpuLimit,
  ownedArgv,
  runIn,
  runOwned,
  runThrough,
  runWatched,
  type Mode,
} from "./cap.ts";
import { isAlive, signalGroup, spawnGroup } from "./signal.ts";

const MIB = 1024 ** 2;
const cap = { memory: 128 * MIB, timeMs: 30_000 };
// 16 MiB every 20 ms, up to 1 GiB: past the cap within a second, and slow enough that the
// fallback's 250 ms sample sees it well before the 1 GiB it stops at.
const RUNAWAY =
  "const a = []; setInterval(() => a.length < 64 && a.push(Buffer.alloc(16 << 20, 1)), 20)";

/** This process's capped scopes still listed; none where there is no systemd. */
const scopesLeft = () =>
  spawnSync(
    "systemctl",
    ["--user", "list-units", "--all", "--no-legend", `bazhen-capped-${process.pid}-*`],
    { encoding: "utf8" },
  ).stdout ?? "";

/** `times` runs of `run`, one after another, as caps on a shared machine should be tested. */
async function oneByOne<T>(times: number, run: () => Promise<T>): Promise<T[]> {
  const ended: T[] = [];
  for (let i = 0; i < times; i += 1) ended.push(await run());
  return ended;
}

/** A command that leaves one process running once it has gone. */
const LEAVES_ONE = "(exec sleep 30) &";

let mode: Mode;
let dir: string;

beforeAll(async () => {
  // A run of its own: inside a capped scope (this one's), chooseMode would run it through.
  mode = cappedScope() === undefined ? (await chooseMode(cap, false)).mode : "scope";
  dir = mkdtempSync(join(tmpdir(), "bz-cap-"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a run through the capped scope around it", () => {
  it("still keeps its own time cap", async () => {
    const ended = await runThrough("sleep", ["30"], { ...cap, timeMs: 1_000 }, process.env);
    expect(ended).toMatchObject({ timedOut: true, signal: "SIGTERM" });
  });

  it("counts what a command it runs through left in its group, and nothing when it left nothing", async () => {
    const left = await runThrough("sh", ["-c", LEAVES_ONE], cap, process.env);
    const clean = await runThrough("sh", ["-c", "sleep 0"], cap, process.env);
    expect([left.leftover, clean.leftover]).toEqual([1, 0]);
  });
});

describe("a capped run", () => {
  it("is killed at its memory cap, and says the memory cap did it", async () => {
    const ended = await runIn(mode, process.execPath, ["-e", RUNAWAY], cap, process.env);
    expect(ended.memoryKills).toBeGreaterThan(0);
    expect(ended.signal).toBe("SIGKILL");
  });

  it("under systemd loses only its biggest process; a watchdog stops all of it", async () => {
    const mark = join(dir, "went-on");
    // sh says it lost the runaway; the test reads that from the mark.
    const script = `exec 2>/dev/null; "${process.execPath}" -e '${RUNAWAY}'; touch "${mark}"`;
    await runIn(mode, "sh", ["-c", script], cap, process.env);
    expect(existsSync(mark)).toBe(mode === "scope");
  });

  it("is stopped at its time cap", async () => {
    const ended = await runIn(mode, "sleep", ["30"], { ...cap, timeMs: 1_000 }, process.env);
    expect(ended).toMatchObject({ timedOut: true, signal: "SIGTERM", memoryKills: 0 });
  });

  it("takes with it what its command left behind, even one that ignores SIGTERM", async () => {
    const pidFile = join(dir, "left");
    const script = `(trap "" TERM; exec sleep 60) & echo $! > "${pidFile}"`;
    await runIn(mode, "sh", ["-c", script], cap, process.env);
    // Killed, it lingers only until whatever inherited it reaps it.
    const pid = Number(readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 2_000 });
  }, 30_000);

  // Where systemd caps, the kernel kills only the runaway, and `sh` exits a moment later, taking
  // the scope and its counter with it: about one run in two lost the kill to that race.
  it.runIf(cappedScope() !== undefined)(
    "counts every kill its command outlived, when asked, though the scope went with the command",
    async () => {
      const outlives = `exec 2>/dev/null; "${process.execPath}" -e '${RUNAWAY}'; exit 0`;
      const runs = await oneByOne(6, () =>
        runIn("scope", "sh", ["-c", outlives], cap, process.env, true),
      );
      expect(runs.map((ended) => ended.memoryKills)).toEqual([1, 1, 1, 1, 1, 1]);
    },
    60_000,
  );

  it("counts what its command left running, and nothing when it left nothing", async () => {
    const left = await runIn(mode, "sh", ["-c", LEAVES_ONE], cap, process.env);
    const clean = await runIn(mode, "sh", ["-c", "sleep 0"], cap, process.env);
    expect([left.leftover, clean.leftover]).toEqual([1, 0]);
  });

  it("leaves no scope behind, whether it exited, ran out of time or was killed", () => {
    expect(scopesLeft()).toBe("");
  });
});

// What `ulimit -d` reads in a test binary its runner caps: no limit where it counts no mappings.
// The limits a test binary its runner caps reads: a data limit on Linux only, and CPU time.
const linux = process.platform === "linux";
const [limitBin, limitArgs] = ownedArgv(
  "sh",
  ["-c", linux ? "ulimit -d; ulimit -t" : "ulimit -t"],
  cap,
);
const expectedLimits = linux ? `${2 * 1024 ** 2}\n${cpuLimit(cap)}` : String(cpuLimit(cap));
// setpriv is what makes a test die with its runner; without it, only its limits bound it.
const diesWithRunner = ownedArgv("x", [], cap)[0] !== "sh";
const pidIn = (file: string) => (existsSync(file) ? Number(readFileSync(file, "utf8")) : 0);

describe("a test binary its runner caps", () => {
  it("is killed at its cap, the runner signalling the group it started", async () => {
    const ended = await runOwned(process.execPath, ["-e", RUNAWAY], cap, process.env);
    expect(ended).toMatchObject({ memoryKills: 1, signal: "SIGKILL" });
  });

  it("is killed with a runaway it started itself, which the kill doesn't leave behind", async () => {
    const pidFile = join(dir, "runaway-child");
    // The runaway names itself before it allocates, so the kill can't come first.
    const named = `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); ${RUNAWAY}`;
    const script = `"${process.execPath}" -e '${named}'; true`;
    const ended = await runOwned("sh", ["-c", script], cap, process.env);
    expect(ended.memoryKills).toBe(1);
    await vi.waitFor(() => expect(pidIn(pidFile)).toBeGreaterThan(1));
    const pid = pidIn(pidFile);
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 2_000 });
  });

  it("counts what it left in its group once it has gone, and nothing when it left nothing", async () => {
    const left = await runOwned("sh", ["-c", LEAVES_ONE], cap, process.env);
    const clean = await runOwned("sh", ["-c", "sleep 0"], cap, process.env);
    expect([left.leftover, clean.leftover]).toEqual([1, 0]);
  });

  it("runs under the limits that hold it when no runner watches it", () => {
    const read = spawnSync(limitBin, limitArgs, { encoding: "utf8" });
    expect(read.stdout.trim()).toBe(expectedLimits);
  });

  it("dies with a runner that is killed outright, where setpriv can arrange it", async () => {
    const pidFile = join(dir, "orphan");
    const runner = [
      `import { runOwned } from ${JSON.stringify(join(import.meta.dirname, "cap.ts"))};`,
      `const cap = ${JSON.stringify(cap)};`,
      `await runOwned("sh", ["-c", "echo $$ > ${pidFile}; exec sleep 5"], cap, process.env);`,
    ].join("\n");
    const child = spawnGroup(process.execPath, ["--input-type=module", "-e", runner], {
      stdio: "ignore",
    });
    await vi.waitFor(() => expect(pidIn(pidFile)).toBeGreaterThan(1));
    const pid = pidIn(pidFile);
    signalGroup(child, "SIGKILL");
    await vi.waitFor(() => expect(isAlive(pid)).toBe(!diesWithRunner), { timeout: 2_000 });
  });
});

describe("the fallback watchdog", () => {
  it("kills the whole tree once its descendants pass the cap", async () => {
    const ended = await runWatched(
      "sh",
      ["-c", `"${process.execPath}" -e '${RUNAWAY}'`],
      cap,
      process.env,
    );
    expect(ended).toMatchObject({ memoryKills: 1, signal: "SIGKILL" });
    expect(ended.peak).toBeGreaterThan(cap.memory);
  });

  it("kills what its command left in its group once the command has gone", async () => {
    const pidFile = join(dir, "left-watched");
    const script = `(trap "" TERM; exec sleep 60) & echo $! > "${pidFile}"`;
    await runWatched("sh", ["-c", script], cap, process.env);
    // Killed, it lingers only until whatever inherited it reaps it.
    const pid = Number(readFileSync(pidFile, "utf8"));
    await vi.waitFor(() => expect(isAlive(pid)).toBe(false), { timeout: 2_000 });
  });

  it("counts what a watched command left in its group, and nothing when it left nothing", async () => {
    const left = await runWatched("sh", ["-c", LEAVES_ONE], cap, process.env);
    const clean = await runWatched("sh", ["-c", "sleep 0"], cap, process.env);
    expect([left.leftover, clean.leftover]).toEqual([1, 0]);
  });

  it("leaves a run under its cap alone", async () => {
    const ended = await runWatched(
      process.execPath,
      ["-e", "Buffer.alloc(16 << 20, 1)"],
      cap,
      process.env,
    );
    expect(ended).toMatchObject({ code: 0, memoryKills: 0, timedOut: false });
  });
});

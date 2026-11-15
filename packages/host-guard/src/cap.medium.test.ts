// Runs real allocators past small caps. Each allocator stops itself at 1 GiB, so a cap that fails
// to fire costs the run 1 GiB and a failed assertion, never the machine's memory.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chooseMode, runIn, runWatched, type Mode } from "./cap.ts";

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

let mode: Mode;
let dir: string;

beforeAll(async () => {
  const chosen = await chooseMode(cap, false, process.env);
  if ("refused" in chosen) throw new Error(chosen.refused);
  mode = chosen.mode;
  dir = mkdtempSync(join(tmpdir(), "bz-cap-"));
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("a capped run", () => {
  it("is killed at its memory cap, and says the memory cap did it", async () => {
    const ended = await runIn(mode, process.execPath, ["-e", RUNAWAY], cap, process.env);
    expect(ended.memoryKills).toBeGreaterThan(0);
    expect(ended.signal).toBe("SIGKILL");
  });

  it("under systemd loses only its biggest process; a watchdog stops all of it", async () => {
    const mark = join(dir, "went-on");
    const script = `"${process.execPath}" -e '${RUNAWAY}'; touch "${mark}"`;
    await runIn(mode, "sh", ["-c", script], cap, process.env);
    expect(existsSync(mark)).toBe(mode === "scope");
  });

  it("is stopped at its time cap", async () => {
    const ended = await runIn(mode, "sleep", ["30"], { ...cap, timeMs: 1_000 }, process.env);
    expect(ended).toMatchObject({ timedOut: true, signal: "SIGTERM", memoryKills: 0 });
  });

  it("leaves no scope behind, whether it exited, ran out of time or was killed", () => {
    expect(scopesLeft()).toBe("");
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

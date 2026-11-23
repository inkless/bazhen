// Runs scripts/capped.ts as cargo runs it. These run inside `moon run :test-medium`'s own capped
// run, which is the capped run a test binary finds around it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cappedScope, chooseMode, runIn } from "../packages/host-guard/src/index.ts";
import { KILLS_ENV, TEST_BINARY_CAP } from "./capped.ts";

const capped = fileURLToPath(new URL("capped.ts", import.meta.url));
const asRunner = (argv: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(capped, ["--test-binary", "--memory", "128M", "--", ...argv], {
    encoding: "utf8",
    timeout: 60_000,
    env,
  });
// 16 MiB every 20 ms, exiting at 1 GiB: past a 128 MiB cap within a second, and done by itself
// where the runner runs it as it is, inside a scope whose own cap is larger.
const RUNAWAY =
  "const a = []; setInterval(() => a.length < 64 ? a.push(Buffer.alloc(16 << 20, 1)) : process.exit(0), 20)";
const SMALL = { memory: 128 * 1024 ** 2, timeMs: 30_000 };
/** A run of its own: a sibling scope beside the one this test runs in, else what the host offers. */
const outerMode = async () => (inScope ? "scope" : (await chooseMode(SMALL, "run")).mode);
const dir = mkdtempSync(join(tmpdir(), "bz-capped-"));
// Inside a capped scope a test binary runs through, whatever the host offers.
const inScope = cappedScope() !== undefined;
// Whether this runner caps its test itself, or runs it through inside the capped scope around it.
let capsItself: boolean;
beforeAll(async () => {
  capsItself = (await chooseMode(TEST_BINARY_CAP, "test-binary")).mode !== "through";
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** An environment whose PATH has no systemd-run: what a host without a user manager offers. */
function withoutSystemd(): NodeJS.ProcessEnv {
  const bin = join(dir, "bin");
  if (!existsSync(bin)) {
    mkdirSync(bin);
    symlinkSync(process.execPath, join(bin, "node"));
    for (const tool of ["/bin/sh", "/usr/bin/top", "/bin/ps"].filter((p) => existsSync(p))) {
      symlinkSync(tool, join(bin, tool.split("/").at(-1) ?? tool));
    }
  }
  return { ...process.env, PATH: bin };
}

describe("capped as cargo's test runner", () => {
  it("runs as an executable, its exit status the test binary's", () => {
    expect(asRunner(["sh", "-c", "echo ran; exit 3"])).toMatchObject({
      status: 3,
      stdout: "ran\n",
    });
  });

  it("dies by the signal its test died by, so nextest reports the signal", () => {
    expect(asRunner(["sh", "-c", "kill -KILL $$"])).toMatchObject({
      status: null,
      signal: "SIGKILL",
    });
  });

  it("ends with the shell's code for a signal Node won't die of", () => {
    expect(asRunner(["sh", "-c", "kill -PIPE $$"])).toMatchObject({ status: 141, signal: null });
  });

  it("names a test it killed at its cap in the file falsify reads", () => {
    const kills = join(dir, "kills");
    asRunner([process.execPath, "-e", RUNAWAY], { ...process.env, [KILLS_ENV]: kills });
    expect(existsSync(kills)).toBe(capsItself);
  });

  it("caps its test itself where systemd can't, outside a capped scope, and names one it killed", () => {
    const kills = join(dir, "kills-owned");
    asRunner([process.execPath, "-e", RUNAWAY], { ...withoutSystemd(), [KILLS_ENV]: kills });
    expect(existsSync(kills)).toBe(!inScope);
  });

  it("names a test killed by the cap of the scope it runs through in", async () => {
    // A run of its own around the runner, with a cap the runaway passes: inside a scope the runner
    // runs its test through, and where systemd can't cap, it caps the test itself.
    const outer = await outerMode();
    const kills = join(dir, "kills-through");
    const said = join(dir, "said-through");
    await runIn(
      outer,
      "sh",
      ["-c", 'exec 2>"$0" "$@"', said, capped, "--test-binary", "--memory", "128M", "--"].concat(
        process.execPath,
        "-e",
        RUNAWAY,
      ),
      SMALL,
      { ...process.env, [KILLS_ENV]: kills },
    );
    expect(existsSync(kills)).toBe(true);
    expect(readFileSync(said, "utf8")).toMatch(/^capped: killed .* 128 MiB memory cap$/m);
  });

  it("names no test that a SIGKILL from elsewhere ended", () => {
    const kills = join(dir, "not-memory");
    asRunner(["sh", "-c", "kill -KILL $$"], { ...process.env, [KILLS_ENV]: kills });
    expect(existsSync(kills)).toBe(false);
  });

  it("refuses a malformed call rather than running something uncapped", () => {
    expect(spawnSync(capped, ["sh", "-c", "true"], { encoding: "utf8" })).toMatchObject({
      status: 2,
      stderr: expect.stringContaining("usage"),
    });
  });
});

/** A run as a task's: inside this one's scope it runs through, and keeps its own time cap. */
const asRun = (time: string, script: string) =>
  spawnSync(capped, ["--memory", "1G", "--time", time, "--", "sh", "-c", script], {
    encoding: "utf8",
  });
/**
 * A run started outside this one's scope, so that it caps a scope of its own as a moon task's
 * does, where the kernel kills only the biggest process and the command can pass regardless.
 */
const asTask = (flags: string[], script: string) =>
  spawnSync(
    "systemd-run",
    [
      "--user",
      "--scope",
      "--quiet",
      "--collect",
      "--",
      capped,
      "--memory",
      "128M",
      "--time",
      "1m",
    ].concat(flags, ["--", "sh", "-c", script]),
    { encoding: "utf8" },
  );
// A run inside the task's run whose command starts a process in a session of its own, as a
// holder does, and which fails on it or not: the task's command passes regardless.
// It waits until the sleep leads its session, so the inner run's own count can't find it still in
// its group.
const startsSession = (flags: string) =>
  `"${capped}" ${flags} --memory 128M --time 1m -- sh -c '` +
  `setsid sleep 30 & until [ "$(ps -o sid= -p $!)" -eq $! ]; do sleep 0.05; done'; exit 0`;
const LEFT_SLEEP = "capped: stopped 1 process(es) its command left running: sleep ×1";
const OUTLIVES_RUNAWAY = `"${process.execPath}" -e '${RUNAWAY}'; exit 0`;
const FAILS = "capped: the run fails, though its command passed:";
// How often a task's run, whose command starts an inner run with `flags` that starts a session,
// says a sleep was left running, and how the task's run ends.
const sessionOutcome = (flags: string) => {
  const task = asTask([], startsSession(flags));
  return { said: task.stderr.split(LEFT_SLEEP).length - 1, status: task.status };
};

describe("capped as a task's run", () => {
  it("fails a run whose command passed once it reached its time cap", () => {
    expect(asRun("1s", 'trap "exit 0" TERM; sleep 30 & wait')).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(`${FAILS} it reached its time cap`),
    });
  });

  it("fails a run whose command passed but left a process running", () => {
    expect(asRun("1m", "(exec sleep 30) &")).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(`${FAILS} its command left processes running`),
    });
  });

  it("names what a run's command left running", () => {
    expect(asRun("1m", "(exec sleep 30) &").stderr).toContain(
      "capped: stopped 1 process(es) its command left running: sleep ×1",
    );
  });

  it.runIf(inScope)("fails a run whose command passed after a memory kill in its own scope", () => {
    expect(asTask([], OUTLIVES_RUNAWAY)).toMatchObject({
      status: 1,
      stderr: expect.stringContaining(`${FAILS} its memory cap killed a process in it`),
    });
  });

  it.runIf(inScope)(
    "ends what a run with a scope of its own started, which a run without one leaves to the task's",
    () => {
      // Said once each time: without the flag by the task's run, which then fails; with it by the
      // inner run that stopped it, so the task's run found nothing left.
      expect({ without: sessionOutcome(""), with: sessionOutcome("--own-scope") }).toEqual({
        without: { said: 1, status: 1 },
        with: { said: 1, status: 0 },
      });
    },
  );

  it.runIf(inScope)("passes a run that counts its memory kills after one in its own scope", () => {
    expect(asTask(["--memory-kills-counted"], OUTLIVES_RUNAWAY)).toMatchObject({
      status: 0,
      stderr: expect.stringContaining("capped: killed 1 process(es) at the 128 MiB memory cap"),
    });
  });
});

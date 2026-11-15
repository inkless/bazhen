// Runs scripts/capped.ts as cargo runs it. These run inside `pnpm test:medium`'s own capped run,
// which is the capped run a test binary finds around it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cappedScope, chooseMode, runIn } from "../packages/host-guard/src/cap.ts";
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
const outerMode = async () => (inScope ? "scope" : (await chooseMode(SMALL, false)).mode);
const dir = mkdtempSync(join(tmpdir(), "bz-capped-"));
// Inside a capped scope a test binary runs through, whatever the host offers.
const inScope = cappedScope() !== undefined;
// Whether this runner caps its test itself, or runs it through inside the capped scope around it.
let capsItself: boolean;
beforeAll(async () => {
  capsItself = (await chooseMode(TEST_BINARY_CAP, true)).mode !== "through";
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
    await runIn(
      outer,
      capped,
      ["--test-binary", "--memory", "128M", "--", process.execPath, "-e", RUNAWAY],
      SMALL,
      { ...process.env, [KILLS_ENV]: kills },
    );
    expect(existsSync(kills)).toBe(true);
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

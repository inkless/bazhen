// Runs scripts/capped.ts as cargo runs it. These run inside `pnpm test:medium`'s own capped run,
// which is the capped run a test binary finds around it.

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chooseMode } from "../packages/host-guard/src/cap.ts";
import { KILLS_ENV, TEST_BINARY_CAP } from "./capped.ts";

const capped = fileURLToPath(new URL("capped.ts", import.meta.url));
const asRunner = (argv: string[], env: NodeJS.ProcessEnv = process.env) =>
  spawnSync(capped, ["--test-binary", "--", ...argv], { encoding: "utf8", timeout: 60_000, env });
const dir = mkdtempSync(join(tmpdir(), "bz-capped-"));
// Whether a test binary gets a scope of its own here. Inside a watched run it runs as it is, and
// the run's watchdog speaks for it.
let ownScope: boolean;
beforeAll(async () => {
  const chosen = await chooseMode(TEST_BINARY_CAP, true, process.env);
  ownScope = "mode" in chosen && chosen.mode === "scope";
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

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

  it("names a test process killed in its own scope in the file falsify reads", () => {
    const kills = join(dir, "kills");
    asRunner(["sh", "-c", "kill -KILL $$"], { ...process.env, [KILLS_ENV]: kills });
    expect(existsSync(kills)).toBe(ownScope);
  });

  it("names nothing for a test that ended by itself", () => {
    const kills = join(dir, "quiet");
    asRunner(["sh", "-c", "exit 1"], { ...process.env, [KILLS_ENV]: kills });
    expect(existsSync(kills)).toBe(false);
  });

  it("refuses a malformed call rather than running something uncapped", () => {
    expect(spawnSync(capped, ["sh", "-c", "true"], { encoding: "utf8" })).toMatchObject({
      status: 2,
      stderr: expect.stringContaining("usage"),
    });
  });
});

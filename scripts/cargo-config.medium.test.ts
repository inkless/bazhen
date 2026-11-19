// Runs `cargo xtask` as a caller does, with a logging `env` first on PATH: the alias names `env` as
// the runner in place of the capping one, so the log shows which runner cargo really started. And
// runs scripts/xtask.sh, which the gate scripts call, under the runners that outrank the alias's
// own, to show it fails a run xtask never saw.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bz-cargo-config-"));
  const env = spawnSync("sh", ["-c", "command -v env"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(dir, "env"), `#!/bin/sh\necho "$*" >> "${dir}/log"\nexec ${env} "$@"\n`);
  chmodSync(join(dir, "env"), 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

function xtask(args: string[]) {
  const run = spawnSync("cargo", ["xtask", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ""}` },
  });
  const log = existsSync(join(dir, "log")) ? readFileSync(join(dir, "log"), "utf8") : "";
  return { status: run.status, log };
}

it("cargo xtask runs xtask through the alias's own runner, not the capping test runner", () => {
  // Wherever the target directory is: falsify builds in one of its own.
  expect(xtask(["nope"])).toEqual({
    status: 2,
    log: expect.stringMatching(/^\S*\/bazhen-xtask nope\n$/),
  });
}, 300_000);

const WRAPPER = join(root, "scripts", "xtask.sh");

/** The host's target triple, as `rustc -vV` names it. */
const host = (): string =>
  /^host: (\S+)$/m.exec(spawnSync("rustc", ["-vV"], { encoding: "utf8" }).stdout)?.[1] ?? "";

/** The variable that sets a runner for the host's triple, which outranks a `cfg()` runner. */
const hostRunner = () => `CARGO_TARGET_${host().toUpperCase().replaceAll("-", "_")}_RUNNER`;

/** `cargo xtask help` run directly, and through scripts/xtask.sh, under `env`. */
function both(env: Record<string, string>) {
  const start = (command: string, args: string[]) => {
    const run = spawnSync(command, args, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: run.status, stderr: run.stderr };
  };
  const wrapped = start(WRAPPER, ["help"]);
  return {
    direct: start("cargo", ["xtask", "help"]).status,
    wrapped: wrapped.status,
    refused: wrapped.stderr.includes("but xtask never ran"),
  };
}

/** A cargo home sharing the real one's downloads, whose config sets `config`. */
function cargoHome(config: string): string {
  const real = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const made = join(dir, "cargo-home");
  mkdirSync(made);
  for (const kept of ["registry", "git"]) symlinkSync(join(real, kept), join(made, kept));
  writeFileSync(join(made, "config.toml"), config);
  return made;
}

describe("scripts/xtask.sh", () => {
  it("passes xtask's own exit on when xtask ran", () => {
    expect({ help: both({}), nope: spawnSync(WRAPPER, ["nope"], { cwd: root }).status }).toEqual({
      help: { direct: 0, wrapped: 0, refused: false },
      nope: 2,
    });
  }, 300_000);

  it("fails a run that a runner for the host's triple, set in the environment, stood in for", () => {
    expect(both({ [hostRunner()]: "true" })).toEqual({ direct: 0, wrapped: 1, refused: true });
  }, 300_000);

  it("fails a run that a runner for the host's triple, set in a cargo config, stood in for", () => {
    const config = `[target.${host()}]\nrunner = "true"\n`;
    expect(both({ CARGO_HOME: cargoHome(config) })).toEqual({
      direct: 0,
      wrapped: 1,
      refused: true,
    });
  }, 300_000);

  // cargo appends an alias from the environment to the configured one, after its `--`.
  it("still runs xtask under an alias in the environment, which only adds what xtask refuses", () => {
    expect(both({ CARGO_ALIAS_XTASK: "version" })).toEqual({
      direct: 2,
      wrapped: 2,
      refused: false,
    });
  }, 300_000);
});

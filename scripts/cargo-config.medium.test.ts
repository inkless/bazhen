// Runs `cargo xtask` as a caller does, with a logging `env` first on PATH: the alias names `env` as
// the runner in place of the capping one, so the log shows which runner cargo really started. And
// runs scripts/xtask.sh, which the gate scripts call, under the runners that outrank the alias's
// own, to show it exits as xtask did, and fails a run xtask never saw or saw other arguments for.

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

/** PATH with `folder` first. */
const firstOnPath = (folder: string): string => `${folder}:${process.env.PATH ?? ""}`;

function xtask(args: string[]) {
  const run = spawnSync("cargo", ["xtask", ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, PATH: firstOnPath(dir) },
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

/** A runner script in the test's folder, made of `body`. */
function runner(name: string, body: string): string {
  writeFileSync(join(dir, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(dir, name), 0o755);
  return join(dir, name);
}

/** `cargo xtask <args>` run directly, and through scripts/xtask.sh, under `env`. */
function both(env: Record<string, string>, args = ["help"]) {
  const start = (command: string, argv: string[]) => {
    const run = spawnSync(command, argv, {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, ...env },
    });
    return { status: run.status, stderr: run.stderr };
  };
  const wrapped = start(WRAPPER, args);
  const said = ["xtask never ran", "xtask ran with other arguments"].find((why) =>
    wrapped.stderr.includes(why),
  );
  return {
    direct: start("cargo", ["xtask", ...args]).status,
    wrapped: wrapped.status,
    said: said ?? "",
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
      help: { direct: 0, wrapped: 0, said: "" },
      nope: 2,
    });
  }, 300_000);

  it("fails a run that a runner for the host's triple, set in the environment, stood in for", () => {
    expect(both({ [hostRunner()]: "true" })).toEqual({
      direct: 0,
      wrapped: 1,
      said: "xtask never ran",
    });
  }, 300_000);

  it("fails a run that a runner for the host's triple, set in a cargo config, stood in for", () => {
    const config = `[target.${host()}]\nrunner = "true"\n`;
    expect(both({ CARGO_HOME: cargoHome(config) })).toEqual({
      direct: 0,
      wrapped: 1,
      said: "xtask never ran",
    });
  }, 300_000);

  it("exits as xtask did, under a runner that runs it but hides its exit", () => {
    const hides = runner("hides", '"$@"\nexit 0');
    expect(both({ [hostRunner()]: hides }, ["nope"])).toEqual({ direct: 0, wrapped: 2, said: "" });
  }, 300_000);

  it("fails a run that a runner started xtask for with other arguments", () => {
    const swaps = runner("swaps", 'exec "$1" help');
    expect(both({ [hostRunner()]: swaps }, ["nope"])).toEqual({
      direct: 0,
      wrapped: 1,
      said: "xtask ran with other arguments",
    });
  }, 300_000);

  // cargo starts xtask under a config's [env], so it reaches xtask's own PATH, which fmt and deny
  // find their tools on.
  it("refuses to format under a config whose [env] puts another cargo-fmt first on PATH", () => {
    runner("cargo-fmt", "exit 0");
    const path = JSON.stringify(firstOnPath(dir));
    const config = `[env]\nPATH = { value = ${path}, force = true }\n`;
    const run = spawnSync(WRAPPER, ["gate", "fmt"], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, CARGO_HOME: cargoHome(config) },
    });
    expect({ status: run.status, refused: run.stderr.includes("sets a test runner") }).toEqual({
      status: 1,
      refused: true,
    });
  }, 300_000);

  // cargo appends an alias from the environment to the configured one, after its `--`.
  it("fails a run that an alias in the environment added arguments to", () => {
    expect(both({ CARGO_ALIAS_XTASK: "version" })).toEqual({
      direct: 2,
      wrapped: 1,
      said: "xtask ran with other arguments",
    });
  }, 300_000);
});

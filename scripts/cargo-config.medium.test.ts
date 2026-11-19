// Runs `cargo xtask` as a caller does, with a logging `env` first on PATH: the alias names `env` as
// the runner in place of the capping one, so the log shows which runner cargo really started. And
// runs scripts/xtask.sh, which the gate scripts call, under the runners that outrank the alias's
// own, to show it runs xtask itself, and under the configs that would have fooled a gate.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
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

/** `cargo xtask <args>` run directly, and through scripts/xtask.sh, under `env`: their exits. */
function both(env: Record<string, string>, args = ["help"]) {
  const start = (command: string, argv: string[]) =>
    spawnSync(command, argv, { cwd: root, env: { ...process.env, ...env } }).status;
  return { direct: start("cargo", ["xtask", ...args]), wrapped: start(WRAPPER, args) };
}

/**
 * A copy of the repository's cargo workspace and its gate wrapper, at `<dir>/repo`, so a test can
 * plant configs in and around it without touching the checkout other tests build in. The files git
 * would take, tracked or new, as they are on disk.
 */
function workspace(): string {
  const copy = join(dir, "repo");
  const kept = ["Cargo.toml", "Cargo.lock", "rust-toolchain.toml", ".cargo/config.toml", "crates"];
  const listed = spawnSync("git", ["ls-files", "-z", "-co", "--exclude-standard", "--", ...kept], {
    cwd: root,
    encoding: "utf8",
  }).stdout;
  const files = listed.split("\0").filter((path) => path !== "" && existsSync(join(root, path)));
  for (const path of [...files, "scripts/xtask.sh"]) {
    mkdirSync(dirname(join(copy, path)), { recursive: true });
    copyFileSync(join(root, path), join(copy, path));
  }
  chmodSync(join(copy, "scripts", "xtask.sh"), 0o755);
  return copy;
}

/** Where cargo puts the checkout's builds, so a copy's build reuses what they built. */
function buildsGoTo(): string {
  const metadata = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
    cwd: root,
    encoding: "utf8",
  }).stdout;
  const named = /"target_directory":"([^"\\]+)"/.exec(metadata)?.[1];
  if (named === undefined) throw new Error(`cargo metadata named no target directory: ${metadata}`);
  return named;
}

/** `gate fmt` in `copy`, through `command`, building where the checkout's builds go. */
function formatCopy(
  copy: string,
  command = join(copy, "scripts", "xtask.sh"),
  args: string[] = [],
) {
  const run = spawnSync(command, [...args, "gate", "fmt"], {
    cwd: copy,
    encoding: "utf8",
    env: { ...process.env, CARGO_TARGET_DIR: buildsGoTo() },
  });
  return { status: run.status, stderr: run.stderr };
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
  it("passes xtask's own exit on", () => {
    expect([both({}), both({}, ["nope"])]).toEqual([
      { direct: 0, wrapped: 0 },
      { direct: 2, wrapped: 2 },
    ]);
  }, 300_000);

  // `cargo xtask` starts xtask through such a runner, which here stands in for it and exits 0.
  it("runs xtask itself under a runner for the host's triple, set in the environment", () => {
    const logs = runner("logs", `echo "$*" >> "${dir}/log"\nexit 0`);
    const exits = both({ [hostRunner()]: logs }, ["nope"]);
    const log = readFileSync(join(dir, "log"), "utf8");
    expect({ exits, ranOnlyDirect: log.split("\n").filter(Boolean).length }).toEqual({
      exits: { direct: 0, wrapped: 2 },
      ranOnlyDirect: 1,
    });
  }, 300_000);

  it("runs xtask itself under a runner for the host's triple, set in a cargo config", () => {
    const config = `[target.${host()}]\nrunner = "true"\n`;
    expect(both({ CARGO_HOME: cargoHome(config) }, ["nope"])).toEqual({ direct: 0, wrapped: 2 });
  }, 300_000);

  // cargo appends an alias from the environment to the configured one, after its `--`; the
  // wrapper runs no alias.
  it("runs xtask with its own arguments under an alias in the environment", () => {
    expect(both({ CARGO_ALIAS_XTASK: "version" })).toEqual({ direct: 2, wrapped: 0 });
  }, 300_000);

  it("refuses to format under a cargo home config whose [env] puts another cargo-fmt first", () => {
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

  // The runner would have started xtask with a root far from the config, so the config check
  // never saw it, and the PATH it set put another cargo-fmt first.
  it("refuses a parent config whose runner would move xtask's root and its PATH", () => {
    const copy = workspace();
    runner("cargo-fmt", "exit 0");
    const elsewhere = mkdtempSync(join(tmpdir(), "bz-elsewhere-"));
    const forged = [
      "env",
      `CARGO_MANIFEST_DIR=${join(elsewhere, "crates", "x")}`,
      `PATH=${firstOnPath(dir)}`,
    ];
    mkdirSync(join(dir, ".cargo"));
    const config = `[target.${host()}]\nrunner = ${JSON.stringify(forged)}\n`;
    writeFileSync(join(dir, ".cargo", "config.toml"), config);
    const direct = formatCopy(copy, "cargo", ["xtask"]).status;
    const { status, stderr } = formatCopy(copy);
    rmSync(elsewhere, { recursive: true, force: true });
    expect({
      direct,
      status,
      refused: stderr.includes(`${dir}/.cargo/config.toml sets a test runner`),
    }).toEqual({ direct: 0, status: 1, refused: true });
  }, 300_000);

  // cargo reads .cargo/config in place of the pinned .cargo/config.toml, and only warns.
  it("refuses to format in a repository with a .cargo/config whose [env] puts another cargo-fmt first", () => {
    const copy = workspace();
    runner("cargo-fmt", "exit 0");
    const path = JSON.stringify(firstOnPath(dir));
    writeFileSync(
      join(copy, ".cargo", "config"),
      `[env]\nPATH = { value = ${path}, force = true }\n`,
    );
    const { status, stderr } = formatCopy(copy);
    expect({ status, refused: stderr.includes(`${copy}/.cargo/config is there`) }).toEqual({
      status: 1,
      refused: true,
    });
  }, 600_000);
});

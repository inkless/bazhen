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

/**
 * `gate fmt` in `copy`, through `command`. Plain `cargo xtask` builds in a folder of the test's
 * own, and scripts/xtask.sh in the copy's, so neither reuses a binary another test built.
 */
function formatCopy(
  copy: string,
  command = join(copy, "scripts", "xtask.sh"),
  args: string[] = [],
  env: Record<string, string> = {},
) {
  const run = spawnSync(command, [...args, "gate", "fmt"], {
    cwd: copy,
    encoding: "utf8",
    env: { ...process.env, CARGO_TARGET_DIR: join(dir, "builds"), ...env },
  });
  return { status: run.status, stderr: run.stderr };
}

/** A copy of the workspace with a file rustfmt would change, so a genuine `gate fmt` fails. */
function misformatted(): string {
  const copy = workspace();
  const lib = join(copy, "crates", "bazhen-pid", "src", "lib.rs");
  writeFileSync(lib, `pub const  MISFORMATTED : u8=0;\n${readFileSync(lib, "utf8")}`);
  return copy;
}

/** Plants `config` as the cargo config of the folder above the copy. */
function parentConfig(config: string): string {
  mkdirSync(join(dir, ".cargo"));
  writeFileSync(join(dir, ".cargo", "config.toml"), config);
  return join(dir, ".cargo", "config.toml");
}

/** The version of `name` that `copy`'s Cargo.lock holds. */
function lockedVersion(copy: string, name: string): string {
  const lock = readFileSync(join(copy, "Cargo.lock"), "utf8");
  const version = new RegExp(`name = "${name}"\\nversion = "([^"]+)"`).exec(lock)?.[1];
  if (version === undefined) throw new Error(`Cargo.lock holds no ${name}`);
  return version;
}

/**
 * A linker at `name` in the test's folder that links with the system's `cc`, then puts a script
 * that exits 0 in place of xtask.
 */
function forger(name: string): string {
  const cc = spawnSync("sh", ["-c", "command -v cc"], { encoding: "utf8" }).stdout.trim();
  return runner(
    name,
    [
      `${cc} "$@" || exit`,
      'out=; prev=; for arg; do [ "$prev" = -o ] && out=$arg; prev=$arg; done',
      "case $out in */bazhen_xtask*) printf '#!/bin/sh\\nexit 0\\n' > \"$out\" ;; esac",
    ].join("\n"),
  );
}

/** The target directory cargo uses for `copy` when nothing names one. */
function targetOf(copy: string): string {
  const { CARGO_TARGET_DIR: _, ...env } = process.env;
  const metadata = spawnSync("cargo", ["metadata", "--no-deps", "--format-version", "1"], {
    cwd: copy,
    encoding: "utf8",
    env,
  }).stdout;
  const named = /"target_directory":"([^"\\]+)"/.exec(metadata)?.[1];
  if (named === undefined) throw new Error(`cargo metadata named no target directory: ${metadata}`);
  return named;
}

/** A `cargo` first on PATH that removes nothing and builds nothing, but prints `executables`. */
function fakeCargo(executables: string[]): Record<string, string> {
  mkdirSync(join(dir, "fake-cargo"));
  const lines = executables.map((path) => JSON.stringify({ reason: "x", executable: path }));
  writeFileSync(join(dir, "fake-cargo", "printed"), lines.map((l) => `${l}\n`).join(""));
  writeFileSync(
    join(dir, "fake-cargo", "cargo"),
    `#!/bin/sh\n[ "$1" = clean ] && exit 0\ncat "${join(dir, "fake-cargo", "printed")}"\n`,
  );
  chmodSync(join(dir, "fake-cargo", "cargo"), 0o755);
  return { ...process.env, PATH: firstOnPath(join(dir, "fake-cargo")) };
}

/** What genuine xtask says of a config it refuses; a forged one says nothing. */
const refusedBy = (stderr: string, config: string) =>
  stderr.includes(`${config} `) && stderr.includes("which the Rust gates can't override");

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
    parentConfig(`[target.${host()}]\nrunner = ${JSON.stringify(forged)}\n`);
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

  it("builds xtask itself under a parent config whose linker would forge it", () => {
    const copy = misformatted();
    const config = parentConfig(
      `[target.${host()}]\nlinker = ${JSON.stringify(forger("forger"))}\n`,
    );
    const direct = formatCopy(copy, "cargo", ["xtask"]).status;
    const { status, stderr } = formatCopy(copy);
    expect({ direct, status, refused: refusedBy(stderr, config) }).toEqual({
      direct: 0,
      status: 1,
      refused: true,
    });
  }, 600_000);

  // [env] reaches rustc, and so the `cc` it links with.
  it("builds xtask itself under a parent config whose [env] puts a forging cc first", () => {
    const copy = misformatted();
    mkdirSync(join(dir, "bin"));
    forger(join("bin", "cc"));
    const path = JSON.stringify(firstOnPath(join(dir, "bin")));
    const config = parentConfig(`[env]\nPATH = { value = ${path}, force = true }\n`);
    const direct = formatCopy(copy, "cargo", ["xtask"]).status;
    const { status, stderr } = formatCopy(copy);
    expect({ direct, status, refused: refusedBy(stderr, config) }).toEqual({
      direct: 0,
      status: 1,
      refused: true,
    });
  }, 600_000);

  // `paths` swaps a dependency's code without changing Cargo.lock; this one doesn't compile.
  it("builds xtask itself under a parent config whose `paths` swaps a dependency", () => {
    const copy = misformatted();
    const version = lockedVersion(copy, "itoa");
    const swapped = join(dir, "itoa");
    mkdirSync(join(swapped, "src"), { recursive: true });
    writeFileSync(
      join(swapped, "Cargo.toml"),
      `[package]\nname = "itoa"\nversion = "${version}"\nedition = "2021"\n`,
    );
    writeFileSync(join(swapped, "src", "lib.rs"), 'compile_error!("swapped itoa");\n');
    const config = parentConfig(`paths = [${JSON.stringify(swapped)}]\n`);
    const direct = formatCopy(copy, "cargo", ["xtask"]);
    const { status, stderr } = formatCopy(copy);
    expect({
      direct: direct.status,
      swapped: direct.stderr.includes("swapped itoa"),
      status,
      refused: refusedBy(stderr, config),
    }).toEqual({ direct: 101, swapped: true, status: 1, refused: true });
  }, 600_000);

  // The build runs with none of the caller's variables but those the wrapper names.
  it("builds xtask with no linker, rustflags or rustc wrapper from the caller's environment", () => {
    const copy = workspace();
    const logs = runner("logs", `echo "$*" >> "${dir}/log"\nexit 1`);
    const linker = `CARGO_TARGET_${host().toUpperCase().replaceAll("-", "_")}_LINKER`;
    const planted = { [linker]: logs, RUSTFLAGS: "--no-such-flag", RUSTC_WRAPPER: logs };
    const run = spawnSync(join(copy, "scripts", "xtask.sh"), ["nope"], {
      cwd: copy,
      encoding: "utf8",
      env: { ...process.env, ...planted },
    });
    expect({ status: run.status, ran: existsSync(join(dir, "log")) }).toEqual({
      status: 2,
      ran: false,
    });
  }, 600_000);

  it("builds xtask itself under a cargo home config whose linker would forge it", () => {
    const copy = misformatted();
    const linker = `[target.${host()}]\nlinker = ${JSON.stringify(forger("forger"))}\n`;
    const home = cargoHome(linker);
    const direct = formatCopy(copy, "cargo", ["xtask"], { CARGO_HOME: home }).status;
    const { status, stderr } = formatCopy(copy, undefined, [], { CARGO_HOME: home });
    expect({ direct, status, refused: refusedBy(stderr, join(home, "config.toml")) }).toEqual({
      direct: 0,
      status: 1,
      refused: true,
    });
  }, 600_000);

  it("names the root it is in, whatever CARGO_MANIFEST_DIR the caller set", () => {
    const copy = workspace();
    const elsewhere = join(dir, "elsewhere", "crates", "x");
    expect(formatCopy(copy, undefined, [], { CARGO_MANIFEST_DIR: elsewhere }).status).toBe(0);
  }, 600_000);
});

describe("scripts/xtask.sh's own build", () => {
  // cargo would read the configs above its own folder, which a symlink can hide from a walk of
  // the names; xtask is built from `/`, wherever the caller and TMPDIR are.
  it("reads no config above the caller's folder or TMPDIR, through a symlink or not", () => {
    const logs = runner("logs", `echo "$*" >> "${dir}/log"\nexit 1`);
    mkdirSync(join(dir, "real", ".cargo"), { recursive: true });
    mkdirSync(join(dir, "real", "tmp"));
    writeFileSync(
      join(dir, "real", ".cargo", "config.toml"),
      `[build]\nrustc-wrapper = ${JSON.stringify(logs)}\n`,
    );
    symlinkSync(join(dir, "real", "tmp"), join(dir, "link"));
    const runs = [join(dir, "real", "tmp"), join(dir, "link")].map(
      (folder) =>
        spawnSync(WRAPPER, ["help"], { cwd: folder, env: { ...process.env, TMPDIR: folder } })
          .status,
    );
    expect({ runs, ran: existsSync(join(dir, "log")) }).toEqual({ runs: [0, 0], ran: false });
  }, 600_000);

  it("builds xtask afresh, so a binary forged in its place is replaced on the next run", () => {
    const copy = workspace();
    const wrapper = join(copy, "scripts", "xtask.sh");
    const built = spawnSync(wrapper, ["help"]).status;
    writeFileSync(join(targetOf(copy), "xtask", "debug", "bazhen-xtask"), "#!/bin/sh\nexit 0\n");
    expect({ built, next: spawnSync(wrapper, ["nope"]).status }).toEqual({ built: 0, next: 2 });
  }, 600_000);

  it("runs only the one executable cargo names, and refuses none or two", () => {
    const runs = [[], ["/bin/true", "/bin/false"], ["/bin/true"]].map((executables) => {
      const run = spawnSync(WRAPPER, ["help"], { encoding: "utf8", env: fakeCargo(executables) });
      rmSync(join(dir, "fake-cargo"), { recursive: true, force: true });
      return { status: run.status, refused: run.stderr.includes("no single executable") };
    });
    expect(runs).toEqual([
      { status: 1, refused: true },
      { status: 1, refused: true },
      { status: 0, refused: false },
    ]);
  });

  it("refuses to build with a config in its own cargo home", () => {
    const copy = workspace();
    const wrapper = join(copy, "scripts", "xtask.sh");
    const built = spawnSync(wrapper, ["help"], { encoding: "utf8" }).status;
    writeFileSync(
      join(targetOf(copy), "xtask", "cargo-home", "config.toml"),
      "[build]\njobs = 1\n",
    );
    const run = spawnSync(wrapper, ["help"], { encoding: "utf8" });
    expect({
      built,
      status: run.status,
      refused: run.stderr.includes("the build's own cargo home has a config.toml"),
    }).toEqual({ built: 0, status: 1, refused: true });
  }, 600_000);
});

// Runs `cargo xtask gate` as `pnpm` does, with stub cargo-* binaries on PATH that log the arguments
// and the whole environment they were started with, so what a gate really hands its tool is
// checked, and held to what the TypeScript rails that share its rules (falsify, holder-mutants,
// check-standards) compute. The gate also reads the cargo configs in the repository's real parent
// directories; one there with a runner or [env] fails these tests too.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { RUST_TOOLS, type RustTool, TEST_BUILD, configFailures, gateEnv } from "./rust-gate.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

// Each line `ARGV: …`, then the environment as `env -0` prints it, after a `ENV:` line.
const STUB = `#!/bin/sh
case "$*" in *--version*) exit "\${STUB_VERSION_EXIT:-0}" ;; esac
echo "ARGV: $*" >> "$STUB_LOG"
echo "ENV:" >> "$STUB_LOG"
env -0 >> "$STUB_LOG"
echo >> "$STUB_LOG"
exit "\${STUB_EXIT:-0}"
`;

// `cargo metadata`, which `lint` asks for the crates to lint alone: two crates, named out of order.
// The schema's example, which a test gate runs first, prints a schema of no messages, and judges
// the corpus that leaves, which is empty.
const CARGO_STUB = `#!/bin/sh
echo "ARGV: $*" >> "$STUB_LOG"
echo "ENV:" >> "$STUB_LOG"
env -0 >> "$STUB_LOG"
echo >> "$STUB_LOG"
case "$*" in
  *emit_schema*verdicts*) echo '[]' ;;
  *emit_schema*) echo '{"$defs":{}}' ;;
  *) echo '{"packages":[{"name":"two"},{"name":"one"}]}' ;;
esac
`;

/** The schema's example as the cargo stub logs it, and its judging of the corpus. */
const EMIT = "run --quiet --locked -p bazhen-protocol --example emit_schema";

let xtask: string;
let xtaskDir: string | undefined;
let dir: string;
let bin: string;
let log: string;
let home: string;

/** The xtask binary cargo builds, wherever its target directory is. */
function buildXtask(): string {
  const run = spawnSync(
    "cargo",
    ["build", "--quiet", "--locked", "-p", "bazhen-xtask", "--message-format=json"],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
  );
  const built = run.stdout
    .split("\n")
    .filter((line) => line.includes('"executable"'))
    .map((line): unknown => JSON.parse(line))
    .map((m) => (typeof m === "object" && m !== null ? Reflect.get(m, "executable") : undefined))
    .find((path): path is string => typeof path === "string");
  if (built === undefined) throw new Error(`cargo build -p bazhen-xtask failed: ${run.stderr}`);
  return built;
}

// A copy of its own: cargo replaces target/debug/bazhen-xtask whenever another build of xtask, such
// as cargo-config.medium.test.ts's `cargo xtask`, uplifts a different artifact there, and a spawn
// between its removing the old one and linking the new one finds nothing to run.
beforeAll(() => {
  xtaskDir = mkdtempSync(join(tmpdir(), "bz-xtask-bin-"));
  xtask = join(xtaskDir, "bazhen-xtask");
  copyFileSync(buildXtask(), xtask);
  chmodSync(xtask, 0o755);
}, 300_000);

afterAll(() => {
  if (xtaskDir !== undefined) rmSync(xtaskDir, { recursive: true, force: true });
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "bz-xtask-gate-"));
  bin = join(dir, "bin");
  home = join(dir, "cargo-home");
  log = join(dir, "stub.log");
  mkdirSync(bin);
  mkdirSync(home);
  for (const tool of ["cargo-fmt", "cargo-clippy", "cargo-deny", "cargo-nextest"]) {
    writeFileSync(join(bin, tool), STUB);
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(join(bin, "cargo"), CARGO_STUB);
  chmodSync(join(bin, "cargo"), 0o755);
  // `env`, which the stubs run to log what they were started with: PATH holds only this folder.
  const env = spawnSync("sh", ["-c", "command -v env"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "env"), `#!/bin/sh\nexec ${env} "$@"\n`);
  chmodSync(join(bin, "env"), 0o755);
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Logged {
  readonly argv: string;
  readonly env: Record<string, string>;
}

function parseLog(text: string): Logged[] {
  return text
    .split("ARGV: ")
    .slice(1)
    .map((entry) => {
      const [argv = "", rest = ""] = entry.split("\nENV:\n");
      const pairs = rest.split("\0").filter((p) => p.includes("="));
      const env = Object.fromEntries(
        pairs.map((p) => [p.slice(0, p.indexOf("=")), p.slice(p.indexOf("=") + 1)]),
      );
      return { argv, env };
    });
}

/**
 * The environment a gate is started in: the stubs on PATH, the crate's directory as `cargo run`
 * names it, unless the caller names the root as scripts/xtask.sh does, having removed it, and the
 * caller's own variables.
 */
function startEnv(env: Record<string, string>) {
  const manifest =
    "BAZHEN_XTASK_ROOT" in env ? {} : { CARGO_MANIFEST_DIR: join(root, "crates", "bazhen-xtask") };
  return { PATH: bin, CARGO_HOME: home, ...manifest, STUB_LOG: log, ...env };
}

/** What a gate run did: its exit, the tools it started, and the hint it gave, if any. */
function gate(command: string[], env: Record<string, string> = {}) {
  rmSync(log, { force: true });
  const [program = "", ...args] = command;
  const run = spawnSync(program, args, { encoding: "utf8", env: startEnv(env) });
  if (run.error !== undefined) throw run.error;
  const logged = existsSync(log) ? parseLog(readFileSync(log, "utf8")) : [];
  return { status: run.status, stderr: run.stderr, logged };
}

const rust = (args: string[], env?: Record<string, string>) => gate([xtask, "gate", ...args], env);

/**
 * A test gate, in a repository of its own that holds only an empty checks.ts: the gate writes the
 * schema's output under its root, which here is never the real repository's.
 */
function testGate(args: string[], env: Record<string, string> = {}) {
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "packages", "protocol", "src"), { recursive: true });
  writeFileSync(join(repo, "packages", "protocol", "src", "checks.ts"), "");
  const run = rust(args, { ...env, BAZHEN_XTASK_ROOT: repo });
  const corpus = join(repo, "target", "protocol-shadow", "corpus.json");
  return { ...run, corpus: existsSync(corpus) ? readFileSync(corpus, "utf8") : undefined, repo };
}

/** The variables the stub itself adds, or that its shell sets: not the gate's. */
const OWN = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
const gateVars = (env: Record<string, string> | undefined) =>
  Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !OWN.has(name)));

/** The test gate's command as nextest is handed it: falsify's build options, and the gate's own. */
const TEST_COMMAND = [
  "nextest",
  "run",
  ...TEST_BUILD,
  "--status-level",
  "fail",
  "--final-status-level",
  "fail",
];

const CALLER = {
  RUSTFLAGS: "--cap-lints allow",
  CARGO_ENCODED_RUSTFLAGS: "--cap-lints=allow",
  CARGO_TARGET_X86_64_UNKNOWN_LINUX_GNU_RUNNER: "true",
  CARGO_ALIAS_CLIPPY: "check",
  NEXTEST_PROFILE: "lax",
  PROPTEST_CASES: "1",
  PROPTEST_RNG_SEED: "42",
  CARGO_TARGET_DIR: "/tmp/target",
};

const withTests = (name: string) =>
  expect.stringMatching(new RegExp(`^clippy --quiet -p ${name} --all-targets --locked `));
const asShipped = (name: string) =>
  expect.stringMatching(new RegExp(`^clippy --quiet -p ${name} --locked `));

describe("cargo xtask gate", () => {
  it("hands the tool its fixed command, the tests named after it, and no caller's flags", () => {
    const { status, logged, corpus, repo } = testGate(["test", "tests::a", "b"], CALLER);
    expect({ status, argv: logged.map((l) => l.argv), corpus }).toEqual({
      status: 0,
      argv: [
        EMIT,
        `${EMIT} -- verdicts ${join(repo, "target", "protocol-shadow", "corpus", "cases.json")}`,
        [...TEST_COMMAND, "tests::a", "b"].join(" "),
      ],
      corpus: "[]\n",
    });
    const caller = { ...CALLER, BAZHEN_XTASK_ROOT: repo };
    expect(gateVars(logged.at(-1)?.env)).toEqual(gateEnv(startEnv(caller)));
  });

  it("lints the workspace, then each crate cargo metadata names alone, with its tests and as it ships", () => {
    const { status, logged } = rust(["lint"]);
    expect(status).toBe(0);
    expect(logged.map((l) => l.argv)).toEqual([
      expect.stringContaining("--workspace --all-targets --all-features"),
      "metadata --no-deps --format-version 1 --locked",
      withTests("one"),
      asShipped("one"),
      withTests("two"),
      asShipped("two"),
    ]);
  });

  it("runs nothing unless it is named a root at a full path, or cargo names the crate's directory", () => {
    const runs = [{ CARGO_MANIFEST_DIR: "" }, { BAZHEN_XTASK_ROOT: "repo" }].map((env) => {
      const { status, stderr, logged } = rust(["fmt"], env);
      return { status, runs: logged.length, said: stderr.includes("or as scripts/xtask.sh") };
    });
    expect(runs).toEqual([0, 1].map(() => ({ status: 2, runs: 0, said: true })));
  });

  // cargo reads it in place of the pinned .cargo/config.toml, and only warns.
  it("refuses every gate in a repository with a .cargo/config, and runs nothing", () => {
    const repo = join(dir, "repo");
    mkdirSync(join(repo, ".cargo"), { recursive: true });
    writeFileSync(join(repo, ".cargo", "config"), "[build]\njobs = 2\n");
    const refused = ["fmt", "lint", "deny", "test"].map((g) => {
      const { status, stderr, logged } = rust([g], { BAZHEN_XTASK_ROOT: repo });
      return { status, refused: stderr.includes(".cargo/config is there"), runs: logged.length };
    });
    expect(refused).toEqual([0, 1, 2, 3].map(() => ({ status: 1, refused: true, runs: 0 })));
  });

  it("fails when the tool does, and starts nothing after it", () => {
    const { status, logged } = rust(["lint"], { STUB_EXIT: "3" });
    expect({ status, runs: logged.length }).toEqual({ status: 1, runs: 1 });
  });

  // cargo starts xtask under an outside config's [env], which could put another cargo-fmt or
  // cargo-deny first on its PATH, so no gate runs under one.
  it("refuses every gate under a config it can't override, and runs nothing", () => {
    writeFileSync(join(home, "config.toml"), '[env]\nCLIPPY_ARGS = "--cap-lints=allow"\n');
    const refused = ["fmt", "lint", "deny", "test"].map((g) => {
      const { status, stderr, logged } = rust([g]);
      return { status, refused: stderr.includes("sets a test runner"), runs: logged.length };
    });
    expect(refused).toEqual(
      ["fmt", "lint", "deny", "test"].map(() => ({ status: 1, refused: true, runs: 0 })),
    );
  });

  it("names the install command when a tool is missing", () => {
    rmSync(join(bin, "cargo-deny"));
    const { status, stderr } = rust(["deny"]);
    expect({ status, hint: stderr.includes("cargo install --locked") }).toEqual({
      status: 1,
      hint: true,
    });
  });

  it("names the toolchain when a tool is there but can't run, as a missing component is", () => {
    const { status, stderr, logged } = rust(["lint"], { STUB_VERSION_EXIT: "1" });
    expect({ status, hint: stderr.includes("install rustup"), runs: logged.length }).toEqual({
      status: 1,
      hint: true,
      runs: 0,
    });
  });
});

// Planted in CARGO_HOME: configs the gates refuse, and ones they run under.
const CONFIGS = [
  '[target.x86_64-unknown-linux-gnu]\nrunner = "true"\n',
  'target = { x86_64-unknown-linux-gnu = { runner = "true" } }\n',
  '[env]\nCLIPPY_ARGS = { value = "--cap-lints=allow", force = true }\n',
  '[ "env" . CLIPPY_ARGS ]\nvalue = "x"\n',
  "  [profile.test]\noverflow-checks = false\n",
  "profile.dev.debug-assertions = false\n",
  'include = ["/elsewhere/more.toml"]\n',
  'paths = ["/elsewhere/serde"]\n',
  '[source.crates-io]\nreplace-with = "mine"\n[source.mine]\ndirectory = "/v"\n',
  '[build]\nrustc-wrapper = "/usr/bin/sccache"\n',
  '# runner = "true" is off\n[net]\ngit-fetch-with-cli = true # no runner = x\n',
  "[environment]\nmyenv = 1\nprofiles = 2\nrunners = 3\n",
  'x = "a#runner = 1"\n',
];

describe("the rules the TypeScript rails share with the Rust gate", () => {
  it("refuse the same cargo configs", () => {
    const path = join(home, "config.toml");
    const judged = CONFIGS.map((text) => {
      writeFileSync(path, text);
      return {
        text,
        rust: rust(["lint"]).status !== 0,
        ts: configFailures([path], () => text).length > 0,
      };
    });
    expect(judged.filter((j) => j.rust !== j.ts)).toEqual([]);
  });

  it("clean the same environment", () => {
    for (const seed of ["", "random", "18446744073709551616", "007"]) {
      const env = { ...CALLER, PROPTEST_RNG_SEED: seed };
      expect(gateVars(rust(["fmt"], env).logged[0]?.env)).toEqual(gateEnv(startEnv(env)));
    }
  });

  it("build the tests falsify lists as the test gate builds them", () => {
    expect(testGate(["test"]).logged.at(-1)?.argv).toBe(TEST_COMMAND.join(" "));
  });
});

const isFile = (path: string) => existsSync(path) && statSync(path).isFile();
const isRustTool = (name: string | undefined): name is RustTool =>
  name !== undefined && Object.hasOwn(RUST_TOOLS, name);

describe("the pinned Rust tools", () => {
  const PINNED = /\b(cargo-(?:nextest|deny|mutants))[@ ]v?(\d[\w.-]*)/g;
  const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((file) => file !== "" && file !== "pnpm-lock.yaml" && isFile(join(root, file)));
  const pins = tracked.flatMap((file) =>
    [...readFileSync(join(root, file), "utf8").matchAll(PINNED)].flatMap(([, tool, version]) =>
      isRustTool(tool) ? [{ file, tool, version }] : [],
    ),
  );
  const named = (file: string) => new Set(pins.filter((p) => p.file === file).map((p) => p.tool));

  it("are installed at the version rust-tools.json names, wherever a file names one", () => {
    expect(pins.filter((pin) => pin.version !== RUST_TOOLS[pin.tool])).toEqual([]);
  });

  it("are all named by CI and the README", () => {
    expect({ ci: named(".github/workflows/ci.yml"), readme: named("README.md") }).toEqual({
      ci: new Set(Object.keys(RUST_TOOLS)),
      readme: new Set(Object.keys(RUST_TOOLS)),
    });
  });
});

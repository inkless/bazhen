// Runs `cargo xtask gate` as `pnpm` does, with stub cargo-* binaries on PATH that log the arguments
// and the whole environment they were started with, so what a gate really hands its tool is
// checked, and held to what the TypeScript rails that share its rules (falsify, holder-mutants,
// check-standards) compute. The gate also reads the cargo configs in the repository's real parent
// directories; one there with a runner or [env] fails these tests too.

import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { GATES, configFailures, gateEnv } from "./cargo-gate.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const GATE_SCRIPT = fileURLToPath(new URL("cargo-gate.ts", import.meta.url));

// Each line `ARGV: …`, then the environment as `env -0` prints it, after a `ENV:` line.
const STUB = `#!/bin/sh
case "$*" in *--version*) exit "\${STUB_VERSION_EXIT:-0}" ;; esac
echo "ARGV: $*" >> "$STUB_LOG"
echo "ENV:" >> "$STUB_LOG"
env -0 >> "$STUB_LOG"
echo >> "$STUB_LOG"
exit "\${STUB_EXIT:-0}"
`;

let xtask: string;
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

beforeAll(() => {
  xtask = buildXtask();
}, 300_000);

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

/** The environment a gate is started in: the stubs on PATH, and the caller's own variables. */
const startEnv = (env: Record<string, string>) => ({
  PATH: bin,
  CARGO_HOME: home,
  STUB_LOG: log,
  ...env,
});

/** What a gate run did: its exit, the tools it started, and the hint it gave, if any. */
function gate(command: string[], env: Record<string, string> = {}) {
  rmSync(log, { force: true });
  const [program = "", ...args] = command;
  const run = spawnSync(program, args, { encoding: "utf8", env: startEnv(env) });
  const logged = existsSync(log) ? parseLog(readFileSync(log, "utf8")) : [];
  return { status: run.status, stderr: run.stderr, logged };
}

const rust = (args: string[], env?: Record<string, string>) => gate([xtask, "gate", ...args], env);
const ts = (args: string[], env?: Record<string, string>) =>
  gate([process.execPath, GATE_SCRIPT, ...args], env);

/** The variables the stub itself adds, or that its shell sets: not the gate's. */
const OWN = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);
const gateVars = (env: Record<string, string> | undefined) =>
  Object.fromEntries(Object.entries(env ?? {}).filter(([name]) => !OWN.has(name)));

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

describe("cargo xtask gate", () => {
  it("hands the tool its fixed command, the tests named after it, and no caller's flags", () => {
    const { status, logged } = rust(["test", "tests::a", "b"], CALLER);
    expect({ status, argv: logged.map((l) => l.argv) }).toEqual({
      status: 0,
      argv: [[...GATES.test.slice(1), "tests::a", "b"].join(" ")],
    });
    expect(gateVars(logged[0]?.env)).toEqual(gateEnv(startEnv(CALLER)));
  });

  it("fails when the tool does, and starts nothing after it", () => {
    const { status, logged } = rust(["lint"], { STUB_EXIT: "3" });
    expect({ status, runs: logged.length }).toEqual({ status: 1, runs: 1 });
  });

  it("refuses to lint or test under a config it can't override, and runs nothing", () => {
    writeFileSync(join(home, "config.toml"), '[env]\nCLIPPY_ARGS = "--cap-lints=allow"\n');
    const refused = ["lint", "test"].map((g) => {
      const { status, stderr, logged } = rust([g]);
      return { status, refused: stderr.includes("sets a test runner"), runs: logged.length };
    });
    expect(refused).toEqual([
      { status: 1, refused: true, runs: 0 },
      { status: 1, refused: true, runs: 0 },
    ]);
  });

  it("formats and checks dependencies under such a config, since neither compiles", () => {
    writeFileSync(join(home, "config.toml"), '[env]\nCLIPPY_ARGS = "--cap-lints=allow"\n');
    expect(["fmt", "deny"].map((g) => rust([g]).status)).toEqual([0, 0]);
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
    expect(rust(["test"]).logged[0]?.argv).toBe(GATES.test.slice(1).join(" "));
  });
});

/** Exit 0, 1 or 2: the TypeScript gate passed a tool's own code through. */
const exitClass = (status: number | null) => (status === 0 || status === 2 ? status : 1);

/** What a gate run did, as both gates must agree on it. */
const seen = (run: ReturnType<typeof gate>) => ({
  exit: exitClass(run.status),
  runs: run.logged.map((l) => [l.argv, gateVars(l.env)]),
});

describe("cargo xtask gate, beside scripts/cargo-gate.ts", () => {
  const cases: [string, string[], Record<string, string>][] = [
    ["each gate", ["fmt"], {}],
    ["lint", ["lint"], {}],
    ["deny", ["deny"], {}],
    ["test", ["test"], CALLER],
    ["test with names", ["test", "a::b", "c"], {}],
    ["test-all off a sandbox", ["test-all"], {}],
    ["an option", ["lint", "--cap-lints", "allow"], {}],
    ["a test name for lint", ["lint", "x"], {}],
    ["an unknown gate", ["build"], {}],
    ["no gate", [], {}],
    ["a failing tool", ["lint"], { STUB_EXIT: "3" }],
    ["a tool that can't run", ["test"], { STUB_VERSION_EXIT: "1" }],
  ];

  it.each(cases)("does as it does for %s", (_, args, env) => {
    const [r, t] = [rust(args, env), ts(args, env)];
    expect(seen(r)).toEqual(seen(t));
  });
});

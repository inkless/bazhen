// Runs one of the Rust gates `pnpm check` relies on (docs/standards/rust.md). Each gate's command is
// fixed here, and runs in an environment no caller's flags reach: a flag can switch every lint off
// (`--cap-lints allow`), whether it comes from the environment, a cargo config in any parent
// directory, or an argument, and a cargo alias can stand in for a whole gate.
//
// Usage: node scripts/cargo-gate.ts <fmt|lint|deny|test>, or test <name>... to run some tests

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.ts";

const root = fileURLToPath(new URL("..", import.meta.url));

// Every gate that compiles also overrides any rustc wrapper or compiler a cargo config names.
export const NO_WRAPPER = [
  "--config",
  'build.rustc-wrapper=""',
  "--config",
  'build.rustc-workspace-wrapper=""',
  "--config",
  'build.rustc="rustc"',
];

// Each subcommand's own binary, called directly: cargo would resolve `cargo clippy` through any
// alias first, and an alias can name a command that passes.
export const GATES = {
  fmt: ["cargo-fmt", "--all", "--check"],
  lint: [
    "cargo-clippy",
    "clippy",
    "--quiet",
    "--workspace",
    "--all-targets",
    "--all-features",
    "--locked",
    ...NO_WRAPPER,
    "--",
    "-D",
    "warnings",
  ],
  deny: ["cargo-deny", "deny", "--locked", "check"],
  test: [
    "cargo-nextest",
    "nextest",
    "run",
    "--workspace",
    "--all-features",
    "--locked",
    ...NO_WRAPPER,
    "--status-level",
    "fail",
    "--final-status-level",
    "fail",
  ],
} as const;
export type Gate = keyof typeof GATES;

const INSTALL_TOOLCHAIN =
  "The Rust gates need cargo, rustfmt and clippy: install rustup, which installs the toolchain " +
  "rust-toolchain.toml pins.";
const INSTALL_TOOLS =
  "The Rust gates need cargo-nextest and cargo-deny. Install them once: " +
  "cargo install --locked cargo-nextest@0.9.152 cargo-deny@0.20.2";

/** Each tool a gate runs, with the command that says it is installed and the hint when it isn't. */
const TOOLS: Record<Gate, { probe: string[]; hint: string }> = {
  fmt: { probe: ["cargo-fmt", "--version"], hint: INSTALL_TOOLCHAIN },
  lint: { probe: ["cargo-clippy", "--version"], hint: INSTALL_TOOLCHAIN },
  deny: { probe: ["cargo-deny", "--version"], hint: INSTALL_TOOLS },
  test: { probe: ["cargo-nextest", "nextest", "--version"], hint: INSTALL_TOOLS },
};

// Variables that change what cargo, rustc, clippy or nextest run, or with which flags.
const REMOVED = new Set([
  "RUSTFLAGS",
  "RUSTDOCFLAGS",
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTDOC",
  "RUSTUP_TOOLCHAIN",
  "CARGO",
  "CLIPPY_CONF_DIR",
  "CLIPPY_ARGS",
]);
const REMOVED_PREFIX =
  /^(CARGO_BUILD_(?!TARGET_DIR$)|CARGO_TARGET_(?!DIR$)|CARGO_ALIAS_|CARGO_PROFILE_|NEXTEST_)/;

/**
 * The environment a gate runs in: the caller's, less everything that changes the build's flags or
 * tools. `CARGO_ENCODED_RUSTFLAGS`, set and empty, outranks every other source of rustflags,
 * cargo config in any parent directory included.
 */
export function gateEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!REMOVED.has(name) && !REMOVED_PREFIX.test(name)) clean[name] = value;
  }
  return { ...clean, CARGO_ENCODED_RUSTFLAGS: "", CARGO_ENCODED_RUSTDOCFLAGS: "" };
}

const isGate = (name: string | undefined): name is Gate =>
  name !== undefined && Object.hasOwn(GATES, name);

const TEST_NAME = /^\w+(?:::\w+)*$/;

/**
 * The gate the arguments name, and for `test` the names of the tests to run. Anything else is
 * refused, so no flag reaches the tool: a test name is a plain path, never an option.
 */
export function parseGate(args: string[]): { gate: Gate; tests: string[] } {
  const [name, ...rest] = args;
  const tests = name === "test" && rest.every((t) => TEST_NAME.test(t)) ? rest : undefined;
  if (!isGate(name) || (rest.length > 0 && tests === undefined)) {
    throw new Error(
      `usage: node scripts/cargo-gate.ts <${Object.keys(GATES).join("|")}>, or test <name>... ` +
        "A gate takes no other arguments: its command is fixed in scripts/cargo-gate.ts.",
    );
  }
  return { gate: name, tests: tests ?? [] };
}

// What a cargo config can set that the gate can't override from the command line: a runner that
// stands in for the test binaries, a rustdoc, or environment variables for the tools (`[env]`,
// which can hand clippy `--cap-lints`). Rustflags, rustc and the wrappers the gate overrides
// itself, so a wrapper such as sccache is fine. Matched in any TOML spelling: under a table,
// dotted, quoted or inline.
const UNSAFE_CONFIG = [
  /(?:^|[\s.{,"'])(?:runner|rustdoc)["']?\s*=/m,
  /^\s*\[\s*["']?env["']?\s*\]|(?:^|[\s{,])["']?env["']?\s*[.=]/m,
];

/**
 * The cargo configs outside the repository that cargo would read for a run in `dir`: one in each
 * parent directory, and one in `cargoHome`.
 */
export function outsideConfigs(dir: string, cargoHome: string): string[] {
  const dirs: string[] = [];
  for (let d = dirname(dir); ; d = dirname(d)) {
    dirs.push(join(d, ".cargo"));
    if (dirname(d) === d) break;
  }
  dirs.push(cargoHome);
  return [...new Set(dirs)].flatMap((d) => [join(d, "config"), join(d, "config.toml")]);
}

/** Why a cargo config outside the repository could change what a gate runs. */
export function configFailures(paths: string[], read: (path: string) => string | undefined) {
  return paths.flatMap((path) => {
    const text = read(path);
    const code = text?.replaceAll(/^\s*#.*$/gm, "");
    return code !== undefined && UNSAFE_CONFIG.some((key) => key.test(code))
      ? [
          `${path} sets a test runner, a rustdoc or [env], which the Rust gates can't override ` +
            "and which could change what they run. Remove it, or move it out of this " +
            "repository's parent directories.",
        ]
      : [];
  });
}

const readIfPresent = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

function main(args: string[]): number {
  let gate: Gate;
  let tests: string[];
  try {
    ({ gate, tests } = parseGate(args));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const env = gateEnv(process.env);
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const compiles = gate === "lint" || gate === "test";
  const failures = compiles ? configFailures(outsideConfigs(root, cargoHome), readIfPresent) : [];
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    return 1;
  }
  const { probe, hint } = TOOLS[gate];
  const [probeBin = "", ...probeArgs] = probe;
  const probed = spawnSync(probeBin, probeArgs, { cwd: root, env, stdio: "ignore" });
  if (probed.error !== undefined || probed.status !== 0) {
    console.error(hint);
    return 1;
  }
  const [bin = "", ...rest] = GATES[gate];
  const run = spawnSync(bin, [...rest, ...tests], { cwd: root, env, stdio: "inherit" });
  if (run.error !== undefined) {
    console.error(run.error.message);
    return 1;
  }
  return run.status ?? 1;
}

if (isMain(import.meta)) process.exit(main(process.argv.slice(2)));

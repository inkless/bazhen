// Runs one of the Rust gates `pnpm check` relies on (docs/standards/rust.md). Each gate's command is
// fixed here, and runs in an environment no caller's flags reach: a flag can switch every lint off
// (`--cap-lints allow`), whether it comes from the environment, a cargo config in any parent
// directory, or an argument, and a cargo alias can stand in for a whole gate.
//
// Usage: node scripts/cargo-gate.ts <fmt|lint|deny|test>, or test <name>... to run some tests

import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMain } from "./is-main.ts";
import { SANDBOX_RULE, SIGNALS_IGNORE, inSignalSandbox } from "./signal-paths.ts";

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
  // The tests ignored as signalling processes they didn't start too, which only a sandbox runs.
  "test-all": [
    "cargo-nextest",
    "nextest",
    "run",
    "--workspace",
    "--all-features",
    "--locked",
    ...NO_WRAPPER,
    "--run-ignored",
    "all",
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
/**
 * The version of each cargo tool the gates and falsify run. CI, the test container and the docs
 * install these, and a test holds them to this list.
 */
export const RUST_TOOLS = {
  "cargo-nextest": "0.9.152",
  "cargo-deny": "0.20.2",
  "cargo-mutants": "27.1.0",
} as const;
export type RustTool = keyof typeof RUST_TOOLS;

/** The command that installs `tools` at their pinned versions. */
export const installCommand = (...tools: RustTool[]): string =>
  `cargo install --locked ${tools.map((tool) => `${tool}@${RUST_TOOLS[tool]}`).join(" ")}`;

const INSTALL_TOOLS =
  "The Rust gates need cargo-nextest and cargo-deny. Install them once: " +
  installCommand("cargo-nextest", "cargo-deny");

/** Each tool a gate runs, with the command that says it is installed and the hint when it isn't. */
const TOOLS: Record<Gate, { probe: string[]; hint: string }> = {
  fmt: { probe: ["cargo-fmt", "--version"], hint: INSTALL_TOOLCHAIN },
  lint: { probe: ["cargo-clippy", "--version"], hint: INSTALL_TOOLCHAIN },
  deny: { probe: ["cargo-deny", "--version"], hint: INSTALL_TOOLS },
  test: { probe: ["cargo-nextest", "nextest", "--version"], hint: INSTALL_TOOLS },
  "test-all": { probe: ["cargo-nextest", "nextest", "--version"], hint: INSTALL_TOOLS },
};

// The holder as it ships, which `lint` checks after the workspace: the workspace pass builds it
// with every feature, and its tests' dev-dependency on itself turns sandbox-tripwire on too, so
// only a pass of its lib and binary alone sees it without.
export const SHIPPED_LINT = [
  "cargo-clippy",
  "clippy",
  "--quiet",
  "-p",
  "bazhen-holder",
  "--lib",
  "--bins",
  "--locked",
  ...NO_WRAPPER,
  "--",
  "-D",
  "warnings",
];

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
  const tests =
    (name === "test" || name === "test-all") && rest.every((t) => TEST_NAME.test(t))
      ? rest
      : undefined;
  if (!isGate(name) || (rest.length > 0 && tests === undefined)) {
    throw new Error(
      `usage: node scripts/cargo-gate.ts <${Object.keys(GATES).join("|")}>, or test <name>... ` +
        "test-all takes names too. A gate takes no other arguments: its command is fixed in scripts/cargo-gate.ts.",
    );
  }
  return { gate: name, tests: tests ?? [] };
}

// What a cargo config can set that the gate can't override from the command line: a runner that
// stands in for the test binaries, a rustdoc or a linker, environment variables for the tools
// (`[env]`, which can hand clippy `--cap-lints`), a profile (which can turn off overflow checks
// and debug assertions in the tests), or another config file to read (`include`), which this
// check wouldn't. Rustflags, rustc and the wrappers the gate overrides itself, so a wrapper such as
// sccache is fine. Matched in any TOML spelling: under a table, dotted, quoted or inline.
const UNSAFE_CONFIG = [
  /(?:^|[\s.{,"'])(?:runner|rustdoc|include|linker)["']?\s*=/m,
  /^\s*\[\s*["']?(?:env|profile)["']?\s*[\].]|(?:^|[\s{,])["']?(?:env|profile)["']?\s*[.=]/m,
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
    const code = text?.replaceAll(/(?:^|\s)#.*$/gm, "");
    return code !== undefined && UNSAFE_CONFIG.some((key) => key.test(code))
      ? [
          `${path} sets a test runner, a rustdoc, a linker, [env], a profile or include, which ` +
            "the Rust gates can't override and which could change what they run. Remove it, or " +
            "move it out of this repository's parent directories.",
        ]
      : [];
  });
}

/** Why a gate won't run on this host: test-all runs tests only a sandbox may. */
export function sandboxRefusal(gate: Gate, sandboxed = inSignalSandbox()): string | undefined {
  if (gate !== "test-all" || sandboxed) return undefined;
  return `Refusing to run: cargo-gate test-all includes each test ignored as "${SIGNALS_IGNORE}": ${SANDBOX_RULE}.`;
}

const readIfPresent = (path: string) => (existsSync(path) ? readFileSync(path, "utf8") : undefined);

/** What `main` reaches outside itself: whether this host is a sandbox, and how it runs a tool. */
export interface GateHost {
  readonly sandboxed: boolean;
  readonly run: (
    bin: string,
    args: string[],
    env: NodeJS.ProcessEnv,
    quiet: boolean,
  ) => SpawnSyncReturns<Buffer>;
}

const thisGateHost = (): GateHost => ({
  sandboxed: inSignalSandbox(),
  run: (bin, args, env, quiet) =>
    spawnSync(bin, args, { cwd: root, env, stdio: quiet ? "ignore" : "inherit" }),
});

/** Runs a gate, and its exit code. */
export function main(args: string[], host: GateHost = thisGateHost()): number {
  let gate: Gate;
  let tests: string[];
  try {
    ({ gate, tests } = parseGate(args));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const refused = sandboxRefusal(gate, host.sandboxed);
  if (refused !== undefined) {
    console.error(refused);
    return 2;
  }
  const env = gateEnv(process.env);
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), ".cargo");
  const compiles = gate === "lint" || gate === "test" || gate === "test-all";
  const failures = compiles ? configFailures(outsideConfigs(root, cargoHome), readIfPresent) : [];
  if (failures.length > 0) {
    console.error(failures.join("\n"));
    return 1;
  }
  const { probe, hint } = TOOLS[gate];
  const [probeBin = "", ...probeArgs] = probe;
  const probed = host.run(probeBin, probeArgs, env, true);
  if (probed.error !== undefined || probed.status !== 0) {
    console.error(hint);
    return 1;
  }
  const commands = gate === "lint" ? [GATES[gate], SHIPPED_LINT] : [GATES[gate]];
  for (const [bin = "", ...rest] of commands) {
    const run = host.run(bin, [...rest, ...tests], env, false);
    if (run.error !== undefined) {
      console.error(run.error.message);
      return 1;
    }
    if (run.status !== 0) return run.status ?? 1;
  }
  return 0;
}

if (isMain(import.meta)) process.exit(main(process.argv.slice(2)));

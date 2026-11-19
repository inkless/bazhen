// What the TypeScript rails share with the Rust gates (`cargo xtask gate`,
// crates/bazhen-xtask/src/gate.rs): the environment a gate cleans, the cargo configs it refuses,
// the test gate's build options, and the cargo tools' pinned versions. falsify, holder-mutants and
// check-standards run cargo as a gate does, and scripts/xtask-gate.medium.test.ts holds each of
// these to the Rust gate's own.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "smol-toml";

/**
 * The test gate's build options (workspace, features, lockfile, wrapper overrides), so the tests
 * falsify lists are the ones the gate runs.
 */
export const TEST_BUILD = [
  "--workspace",
  "--all-features",
  "--locked",
  "--config",
  'build.rustc-wrapper=""',
  "--config",
  'build.rustc-workspace-wrapper=""',
  "--config",
  'build.rustc="rustc"',
] as const;

export type RustTool = "cargo-nextest" | "cargo-deny" | "cargo-mutants";

/**
 * The version of each cargo tool the gates and falsify run, from the file the Rust gate reads.
 * CI, the test container and the docs install these, and a test holds them to this list.
 */
export const RUST_TOOLS: Readonly<Record<RustTool, string>> = (() => {
  const file = new URL("../crates/bazhen-xtask/rust-tools.json", import.meta.url);
  const pins: unknown = JSON.parse(readFileSync(file, "utf8"));
  const version = (tool: RustTool): string => {
    const v: unknown =
      typeof pins === "object" && pins !== null ? Reflect.get(pins, tool) : undefined;
    if (typeof v !== "string")
      throw new Error(`crates/bazhen-xtask/rust-tools.json pins no ${tool}`);
    return v;
  };
  return {
    "cargo-nextest": version("cargo-nextest"),
    "cargo-deny": version("cargo-deny"),
    "cargo-mutants": version("cargo-mutants"),
  };
})();

/** The command that installs `tools` at their pinned versions. */
export const installCommand = (...tools: RustTool[]): string =>
  `cargo install --locked ${tools.map((tool) => `${tool}@${RUST_TOOLS[tool]}`).join(" ")}`;

// Variables that change what cargo, rustc, clippy, nextest or proptest run, or with which flags,
// and the root scripts/xtask.sh names, which is xtask's alone.
const REMOVED = new Set([
  "BAZHEN_XTASK_ROOT",
  "PROPTEST_CASES",
  "RUSTFLAGS",
  "RUSTDOCFLAGS",
  "RUSTC",
  "RUSTC_WRAPPER",
  "RUSTC_WORKSPACE_WRAPPER",
  "RUSTDOC",
  "RUSTFMT",
  "RUSTUP_TOOLCHAIN",
  "CARGO",
  "CLIPPY_CONF_DIR",
  "CLIPPY_ARGS",
]);
/**
 * Variables with a removed prefix but for the target directory, how many jobs cargo builds with and
 * how many tests nextest runs at once: a shared host caps the last two, and neither changes what is
 * built or run, or with which flags.
 */
const REMOVED_PREFIX =
  /^(CARGO_BUILD_(?!(?:TARGET_DIR|JOBS)$)|CARGO_TARGET_(?!DIR$)|CARGO_ALIAS_|CARGO_PROFILE_|NEXTEST_(?!TEST_THREADS$))/;

/**
 * The seed every proptest draws its cases from unless the caller gives one, so that a run tests the
 * change and not the draw: the scheduled job in `.github/workflows/fuzz.yml` gives a random one.
 * Changing it changes every property's cases.
 */
export const PROPTEST_SEED = "1";

/** `seed` if proptest reads it as a seed, a u64; anything else it would replace with a random one. */
function proptestSeed(seed: string | undefined): string {
  return seed !== undefined && /^\d{1,20}$/.test(seed) && BigInt(seed) < 2n ** 64n
    ? seed
    : PROPTEST_SEED;
}

/**
 * The environment a gate runs in: the caller's, less everything that changes the build's flags,
 * tools or test cases, with proptest's seed fixed unless the caller gave one. `CARGO_ENCODED_RUSTFLAGS`,
 * set and empty, outranks every other source of rustflags, cargo config in any parent directory
 * included.
 */
export function gateEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(env)) {
    if (!REMOVED.has(name) && !REMOVED_PREFIX.test(name)) clean[name] = value;
  }
  return {
    ...clean,
    PROPTEST_RNG_SEED: proptestSeed(env.PROPTEST_RNG_SEED),
    CARGO_ENCODED_RUSTFLAGS: "",
    CARGO_ENCODED_RUSTDOCFLAGS: "",
  };
}

// What a cargo config can set that the gate can't override from the command line: a runner that
// stands in for the test binaries or for xtask itself, a rustdoc or a linker, environment variables
// (`[env]`, which can hand clippy `--cap-lints` or put another `cargo-fmt` first on PATH), a
// profile (which can turn off overflow checks and debug assertions in the tests), or another config
// file to read (`include`), which this check wouldn't. Rustflags, rustc and the wrappers the gate
// overrides itself, so a wrapper such as sccache is fine. A config is parsed as TOML and each key
// read as cargo reads it, quoted, escaped, dotted or inline; one that doesn't parse is refused, as
// cargo's reading of it can't be vouched for.
const REFUSED_KEYS = new Set([
  "runner",
  "rustdoc",
  "linker",
  "include",
  "env",
  "profile",
  "paths",
  "replace-with",
]);

/** Whether a parsed config value, or any table within it, sets a key the gate refuses. */
function setsRefusedKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(setsRefusedKey);
  if (value === null || typeof value !== "object" || value instanceof Date) return false;
  return Object.entries(value).some(
    ([key, inner]) => REFUSED_KEYS.has(key) || setsRefusedKey(inner),
  );
}

/** Why a config's text could change what a gate runs, if it could. */
function refusal(text: string): string | undefined {
  let table: unknown;
  try {
    table = parse(text);
  } catch {
    return "isn't TOML that cargo's reading of could be vouched for";
  }
  return setsRefusedKey(table)
    ? "sets a test runner, a rustdoc, a linker, [env], a profile, include, paths or a source's replace-with"
    : undefined;
}

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
    const why = text === undefined ? undefined : refusal(text);
    return why === undefined
      ? []
      : [
          `${path} ${why}, which the Rust gates can't override and which could change what ` +
            "they run. Remove it, or move it out of this repository's parent directories.",
        ];
  });
}

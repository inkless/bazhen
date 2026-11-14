// Falsification harness (docs/standards/testing.md). It answers one question about the tests a
// branch adds: would they fail if the branch's source change were not there?
//
// It runs the branch's new tests against the base's version of the source, in a throwaway
// worktree, and classifies each new test:
//   KILLED    it failed: the test depends on the change. Good.
//   SURVIVED  it passed without the change: it cannot detect the change. Not allowed. Only a test
//             that directly imports a reverted file can survive; one that passes otherwise is
//             unrelated to the source change and comes out INVALID.
//   INVALID   no verdict: it couldn't load, timed out, was skipped, its title couldn't be read or
//             isn't unique, or it passed but is unrelated to the source change; a branch that
//             adds tests without a source change also lands here. Every test of a brand-new
//             symbol is INVALID, so it needs a hand-run control
//             recorded as a trailer in a commit on the branch:
//             `Control: <what you broke> -> <how the test failed>`.
//
// A Rust test under crates/ lives in the file it tests, so reverting the source would revert the
// test with it. When the branch touches the Rust workspace, nextest lists the tests at the base and
// at HEAD, so a test is found however it is declared (`#[test]`, proptest, a macro of the crate's
// own). Each new one is run instead against the mutants cargo-mutants lists in the code the branch
// changed, one at a time in a throwaway worktree: KILLED by the first mutant it fails under twice
// with a panic in test code, else INVALID, needing a Control trailer naming it by its full path,
// `Control: tests::name: <what you broke> -> <how the test failed>`
// (docs/standards/rust.md § Tests).
//
// Titles come from added lines that look like `it(...)`/`test(...)` calls, so a fixture string in
// a test file such as 'it("fixture", f)' counts as a test too. It then can't be found in the
// report and comes out INVALID: the safe direction, since it asks for a control.
//
// Only committed work is judged: the worktree is checked out at HEAD, so commit before running.
// The temporary worktree is locked with this process's pid. A run killed before it could clean
// up leaves it behind, and the next run removes it once that pid is dead.
//
// Usage:
//   node scripts/falsify.ts [--base <ref>]
// The branch is compared with its merge base with <ref>; <ref> defaults to origin/main, or main
// when there is no origin.

import { execFileSync, type ChildProcess } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { isAlive, signalGroup, spawnGroup } from "@bazhen/host-guard";
import { GATES, configFailures, gateEnv, outsideConfigs } from "./cargo-gate.ts";
import { isMain } from "./is-main.ts";
import {
  failedOnAssertion,
  filterable,
  unmutate,
  libtestTargets,
  nextestFilter,
  parseMutants,
  productSpans,
  testEvents,
  type LineSpan,
  type Mutant,
  type RustTest,
} from "./rust-mutants.ts";

export type Outcome = "KILLED" | "SURVIVED" | "INVALID";
export type Change = { status: string; path: string; oldPath?: string };

const TEST_FILE = /(^|\/)[^/]+\.test\.tsx?$/;
const REVERTIBLE = /^(apps|packages)\/[^/]+\/src\//;
const TITLE = /(?<![.\w])(?:it|test)(?:\.\w+(?:\([^()]*\))?)*\(\s*(["'`])((?:\\.|(?!\1).)+)\1/g;
const TEST_CALL = /(?<![.\w])(?:it|test)(?:\.\w+)*\s*\(/;
const CONTROL_TRAILER = /^Control: .+ -> .+$/m;
const WORKTREE_PREFIX = "bz-falsify-";
const LOCK_REASON = /^bz-falsify pid=(\d+)$/;
const INSTALL_TIMEOUT_MS = 120_000;
const VITEST_TIMEOUT_MS = 300_000;
const CARGO_TIMEOUT_MS = 900_000;
// The most mutants run for one branch. A count, not a time budget, so a verdict is the same on
// every machine; a hook-crate mutant builds and runs in under a second.
const MAX_MUTANTS = 100;
const MUTANT_TIMEOUT_MS = 300_000;
// nextest's libtest JSON is experimental; the version pins its shape.
const LIBTEST_JSON_VERSION = "0.1";
// The test gate's build options (workspace, features, lockfile, wrapper overrides), so the tests
// listed are the ones the gate runs.
const TEST_BUILD = GATES.test.slice(
  GATES.test.indexOf("run") + 1,
  GATES.test.indexOf("--status-level"),
);
const KILL_GRACE_MS = 2000;

// Inherited, these point every git command at another repository or index: git exports them to
// hooks, and a caller may set them. Every git command here, and everything run in the temporary
// worktree, gets them stripped, so the repository is always the one the working directory is in.
const GIT_LOCATION_VARS = [
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_WORK_TREE",
  "GIT_PREFIX",
  "GIT_OBJECT_DIRECTORY",
  "GIT_COMMON_DIR",
];

function isolatedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of GIT_LOCATION_VARS) delete env[name];
  return env;
}

const git = (args: string[], cwd = process.cwd()) =>
  execFileSync("git", args, {
    cwd,
    env: isolatedEnv(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });

export function parseNameStatus(out: string): Change[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      const status = parts[0]?.[0] ?? "";
      const path = parts[parts.length - 1] ?? "";
      return (status === "R" || status === "C") && parts.length >= 3
        ? { status, path, oldPath: parts[1] ?? "" }
        : { status, path };
    });
}

const unescape = (title: string) => title.replace(/\\(["'`])/g, "$1");

/**
 * Titles of tests whose `it(...)`/`test(...)` line the change adds. Every added test call whose
 * title can't be read (wrapped onto the next line, interpolated, a variable) adds an
 * `<unparsed test in FILE>` marker, which classifies as INVALID and so forces a Control trailer.
 * An existing test whose call line only became `async`, for a seam that did, is left out: it
 * isn't new, and its behaviour may not have changed at all. A test removed and added again with
 * the same call line, as when it is rewritten elsewhere in the file, is judged like a new one.
 */
export function newTitles(diff: string, file: string): string[] {
  const added = new Map<string, string>();
  const removed = new Map<string, string>();
  for (const line of diff.split("\n")) {
    const side = line.startsWith("+") ? added : line.startsWith("-") ? removed : undefined;
    if (side === undefined || /^(\+\+\+|---) /.test(line) || !TEST_CALL.test(line)) continue;
    let parsed = false;
    for (const [, quote, title] of line.matchAll(TITLE)) {
      if (title === undefined || (quote === "`" && title.includes("${"))) continue;
      side.set(unescape(title), line.slice(1).trim());
      parsed = true;
    }
    if (!parsed && side === added) added.set(`<unparsed test in ${file}>`, "");
  }
  const onlyMadeAsync = (title: string, call: string) => {
    const before = removed.get(title);
    return before !== undefined && before !== call && withoutAsync(before) === withoutAsync(call);
  };
  return [...added].flatMap(([title, call]) => (onlyMadeAsync(title, call) ? [] : [title]));
}

const withoutAsync = (call: string) => call.replaceAll(/\basync\s+/g, "");

// What can change the set of Rust tests: a crate's files, or the workspace's manifest and lockfile.
const RUST_INPUT = /^(?:crates\/|Cargo\.(?:toml|lock)$)/;

/**
 * Each test in a `cargo nextest list --message-format json` report, as `<target> <test name>`.
 * A crate's library and binaries share one target, its name, so a unit test moved between them
 * is the same test; an integration test's target is its own binary (`crate::file`). Throws on
 * anything that isn't such a report, so a list that went wrong is never read as empty.
 */
export function rustTestIds(report: unknown): string[] {
  const suites =
    typeof report === "object" && report !== null && "rust-suites" in report
      ? report["rust-suites"]
      : undefined;
  if (typeof suites !== "object" || suites === null) {
    throw new Error("not a nextest list report: no rust-suites");
  }
  return Object.entries(suites).flatMap(([binary, suite]: [string, unknown]) => {
    const cases =
      typeof suite === "object" && suite !== null && "testcases" in suite
        ? suite.testcases
        : undefined;
    if (typeof cases !== "object" || cases === null) {
      throw new Error(`not a nextest list report: ${binary} has no testcases`);
    }
    const target = binary.replace(/::bin\/.*$/, "");
    return Object.keys(cases).map((name) => `${target} ${name}`);
  });
}

/**
 * The tests listed at HEAD that weren't at the base, as `{ file: target, title: path }`. Counted,
 * not compared as sets: a crate's library and binaries share a target, so a new test with the
 * same path as one the base has elsewhere in the crate is still new.
 */
export function addedRustTests(base: string[], head: string[]): { file: string; title: string }[] {
  const before = new Map<string, number>();
  for (const id of base) before.set(id, (before.get(id) ?? 0) + 1);
  return head
    .filter((id) => {
      const left = before.get(id) ?? 0;
      before.set(id, left - 1);
      return left <= 0;
    })
    .map((id) => {
      const space = id.indexOf(" ");
      return { file: id.slice(0, space), title: id.slice(space + 1) };
    });
}

const CONTROL_SUBJECT = /^Control: (.+) -> .+$/gm;
const escapeRegExp = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * The Rust tests no `Control:` trailer names. A trailer names a test when the part before its
 * `->` holds the test's full path (`module::name`) as a whole word. The target isn't part of it,
 * so one trailer covers the same path added in two crates on one branch.
 */
export function uncontrolledRustTests(names: string[], messages: string): string[] {
  const subjects = [...messages.matchAll(CONTROL_SUBJECT)].map(([, subject = ""]) => subject);
  return names.filter((name) => {
    const named = new RegExp(`(?<!\\w|::)${escapeRegExp(name)}(?!\\w|::)`);
    return !subjects.some((subject) => named.test(subject));
  });
}

export type VitestReport = {
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { title: string; status: string; failureMessages: string[] }[];
  }[];
};

export function isReport(value: unknown): value is VitestReport {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { testResults?: unknown }).testResults)
  );
}

export function classify(report: VitestReport, file: string, title: string): Outcome {
  const suite = report.testResults.find((r) => r.name.endsWith(file));
  if (!suite || suite.assertionResults.length === 0) return "INVALID";
  const matches = suite.assertionResults.filter((a) => a.title === title);
  const test = matches[0];
  if (test === undefined || matches.length > 1) return "INVALID";
  if (test.status === "passed") return "SURVIVED";
  if (test.failureMessages.some((m) => /Test timed out/.test(m))) return "INVALID";
  return test.status === "failed" ? "KILLED" : "INVALID";
}

// Runtime imports: `import … from`/`export … from` (not `import type`), `import "…"` and
// `import("…")`. A type-only import can't change what a test does at run time.
const STATIC_IMPORT = /\b(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT = /\bimport\s*\(?\s*["']([^"']+)["']/g;
const WORKSPACE = /^(@bazhen\/[^/]+)/;

/**
 * The reverted paths a test file imports directly: a relative specifier resolved against the
 * test's folder (with `.ts`, `.tsx` or `/index.ts` tried when it has no extension), or a
 * workspace package (`@bazhen/x`, `@bazhen/x/sub`), which counts every reverted path under that
 * package's folder. `packages` maps package names to folders, e.g. `@bazhen/core` →
 * `packages/core`.
 */
export function relatedReverts(
  testPath: string,
  testSource: string,
  revertedPaths: string[],
  packages: Record<string, string>,
): string[] {
  const specifiers = [
    ...[...testSource.matchAll(STATIC_IMPORT)].filter((m) => !m[1]).map((m) => m[2]),
    ...[...testSource.matchAll(BARE_IMPORT)].map((m) => m[1]),
  ].filter((s): s is string => s !== undefined);
  const related = new Set<string>();
  for (const specifier of specifiers) {
    if (specifier.startsWith(".")) {
      const path = posix.join(posix.dirname(testPath), specifier);
      const candidates = /\.[cm]?[jt]sx?$/.test(path)
        ? [path]
        : [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`];
      for (const r of revertedPaths) if (candidates.includes(r)) related.add(r);
    } else {
      const dir = packages[WORKSPACE.exec(specifier)?.[1] ?? ""];
      if (dir === undefined) continue;
      for (const r of revertedPaths) if (r.startsWith(`${dir}/`)) related.add(r);
    }
  }
  return [...related];
}

/** Workspace package names mapped to their folders, read from apps/* and packages/*. */
function workspacePackages(top: string): Record<string, string> {
  const packages: Record<string, string> = {};
  for (const group of ["apps", "packages"]) {
    if (!existsSync(join(top, group))) continue;
    for (const name of readdirSync(join(top, group))) {
      const manifest = join(top, group, name, "package.json");
      if (!existsSync(manifest)) continue;
      const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      if (typeof parsed === "object" && parsed !== null && "name" in parsed) {
        if (typeof parsed.name === "string") packages[parsed.name] = `${group}/${name}`;
      }
    }
  }
  return packages;
}

/** The `bz-falsify-` worktrees in `git worktree list --porcelain` output whose locking pid is dead. */
export function staleWorktrees(porcelain: string, alive: (pid: number) => boolean): string[] {
  return porcelain
    .split("\n\n")
    .map((block) => {
      const path = /^worktree (.+)$/m.exec(block)?.[1];
      const pid = LOCK_REASON.exec(/^locked (.*)$/m.exec(block)?.[1] ?? "")?.[1];
      return { path, pid: pid === undefined ? undefined : Number(pid) };
    })
    .filter(
      (w): w is { path: string; pid: number } =>
        w.path !== undefined &&
        basename(w.path).startsWith(WORKTREE_PREFIX) &&
        w.pid !== undefined &&
        !alive(w.pid),
    )
    .map((w) => w.path);
}

/** Removes the worktrees of earlier runs that died before cleaning up. Never touches others. */
function sweepStale(top: string): void {
  const listed = git(["worktree", "list", "--porcelain"], top);
  for (const path of staleWorktrees(listed, (pid) => pid > 1 && isAlive(pid))) {
    removeWorktree(path, top);
  }
}

function removeWorktree(dir: string, top: string): void {
  const quiet = (args: string[]) => {
    try {
      git(args, top);
    } catch {
      // Already unlocked or gone.
    }
  };
  quiet(["worktree", "unlock", dir]);
  quiet(["worktree", "remove", "--force", dir]);
  if (existsSync(dir)) {
    // `worktree remove` refused (a file it couldn't delete): delete the folder, then drop the
    // registration, which `remove --force` does for a missing folder.
    rmSync(dir, { recursive: true, force: true });
    quiet(["worktree", "remove", "--force", dir]);
  }
}

// The long steps run asynchronously so a SIGINT or SIGTERM is handled while they run. Each child
// leads its own process group (pnpm and vitest start their own children), and a signal or a
// timeout stops the whole group, then the temporary worktree is removed.
let running: ChildProcess | undefined;
let cleanup: (() => void) | undefined;
let signalled = false;

const exitCodeFor = (signal: unknown) =>
  signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : signal === "SIGHUP" ? 129 : undefined;

/** SIGTERM to the child's group, then SIGKILL after a grace period. */
async function stopGroup(child: ChildProcess): Promise<void> {
  signalGroup(child, "SIGTERM");
  await new Promise<void>((done) => {
    const timer = setTimeout(done, KILL_GRACE_MS);
    if (child.exitCode !== null || child.signalCode !== null) {
      clearTimeout(timer);
      done();
    }
    child.once("exit", () => {
      clearTimeout(timer);
      done();
    });
  });
  signalGroup(child, "SIGKILL");
}

async function onSignal(signal: NodeJS.Signals): Promise<void> {
  signalled = true;
  try {
    if (running) await stopGroup(running);
  } finally {
    // A timeout may be stopping the same group, and signalGroup throws once it has gone.
    cleanup?.();
    process.exit(exitCodeFor(signal) ?? 1);
  }
}

const handleSignal = (signal: NodeJS.Signals) => void onSignal(signal);

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: { env?: NodeJS.ProcessEnv; stdout?: number } = {},
): Promise<boolean> {
  return new Promise((done) => {
    const child = spawnGroup(cmd, args, {
      cwd,
      env: options.env ?? isolatedEnv(),
      stdio: ["ignore", options.stdout ?? "ignore", "ignore"],
    });
    running = child;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void stopGroup(child);
    }, timeoutMs);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      // After a signal, onSignal owns the exit: main must not go on to the next step.
      if (signalled) return;
      running = undefined;
      done(ok && !timedOut);
    };
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

// --ignore-scripts: the root `prepare` script (husky) would set core.hooksPath in the shared git
// config, and nothing else needs a lifecycle script (node-pty's build is declined via
// allowBuilds).
async function install(dir: string): Promise<boolean> {
  const flags = ["--frozen-lockfile", "--ignore-scripts"];
  return (
    (await run("pnpm", ["install", ...flags, "--offline"], dir, INSTALL_TIMEOUT_MS)) ||
    run("pnpm", ["install", ...flags, "--prefer-offline"], dir, INSTALL_TIMEOUT_MS)
  );
}

/**
 * A detached worktree of `commit` in `dir`, locked in the same step as it is created, so a crash
 * can never leave an unlocked (and so never-swept) worktree behind.
 */
function addWorktree(dir: string, commit: string, top: string): void {
  git(["worktree", "add", "--quiet", "--detach", "--lock", "--reason", LOCK, dir, commit], top);
}

const LOCK = `bz-falsify pid=${process.pid}`;

const rustEnv = (top: string): NodeJS.ProcessEnv => ({
  ...gateEnv(isolatedEnv()),
  CARGO_TARGET_DIR: join(top, "target", "falsify"),
});

/**
 * Runs a command in `dir` with its stdout in `dir/<file>`, and returns whether it exited 0 and
 * what it printed.
 */
async function capture(
  cmd: string,
  args: string[],
  dir: string,
  file: string,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ ok: boolean; out: string }> {
  const path = join(dir, file);
  const fd = openSync(path, "w");
  let ok: boolean;
  try {
    ok = await run(cmd, args, dir, options.timeoutMs, { env: options.env, stdout: fd });
  } finally {
    closeSync(fd);
  }
  return { ok, out: readFileSync(path, "utf8") };
}

/**
 * The nextest list report for `dir`, through the Rust gates' clean environment, or undefined when
 * it couldn't list the tests. A tree with no Cargo workspace has none.
 */
async function listRustTests(dir: string, top: string): Promise<unknown> {
  if (!existsSync(join(dir, "Cargo.toml"))) return { "rust-suites": {} };
  const args = ["nextest", "list", ...TEST_BUILD, "--message-format", "json"];
  const { ok, out } = await capture("cargo-nextest", args, dir, "falsify-nextest.json", {
    env: rustEnv(top),
    timeoutMs: CARGO_TIMEOUT_MS,
  });
  if (!ok) return undefined;
  try {
    const report: unknown = JSON.parse(out);
    rustTestIds(report);
    return report;
  } catch {
    return undefined;
  }
}

const MUTANTS_HINT =
  "if cargo-mutants is missing, install it: cargo install --locked cargo-mutants@27.1.0";

/** The mutants cargo-mutants lists in `dir`, with `--in-diff <diff>` or for the whole workspace. */
async function listMutants(dir: string, top: string, diff?: string): Promise<unknown> {
  const args = ["mutants", "--list", "--json", "--no-config", "--workspace"];
  const scoped = diff === undefined ? [] : ["--diff", "--in-diff", diff];
  const { ok, out } = await capture(
    "cargo-mutants",
    [...args, ...scoped],
    dir,
    "falsify-mutants.json",
    { env: rustEnv(top), timeoutMs: CARGO_TIMEOUT_MS },
  );
  if (!ok) throw new Error("cargo-mutants failed");
  return JSON.parse(out);
}

// Each test's own timeout, so a mutant that loops ends that test, not the whole run.
const NEXTEST_PROFILE = `[profile.falsify]
slow-timeout = { period = "5s", terminate-after = 2 }
fail-fast = false
`;

/** Runs `tests` once in `dir` and returns nextest's libtest-json-plus output, however it exited. */
async function runRustTests(dir: string, top: string, tests: RustTest[]): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...rustEnv(top), NEXTEST_EXPERIMENTAL_LIBTEST_JSON: "1" };
  // A backtrace names product code, which would read as a crash rather than an assertion.
  delete env["RUST_BACKTRACE"];
  delete env["RUST_LIB_BACKTRACE"];
  const args = [
    "nextest",
    "run",
    ...TEST_BUILD,
    "--tool-config-file",
    `falsify:${join(dir, "falsify-nextest.toml")}`,
    "--profile",
    "falsify",
    "--message-format",
    "libtest-json-plus",
    "--message-format-version",
    LIBTEST_JSON_VERSION,
    "-E",
    nextestFilter(tests),
  ];
  const { out } = await capture("cargo-nextest", args, dir, "falsify-results.json", {
    env,
    timeoutMs: MUTANT_TIMEOUT_MS,
  });
  return out;
}

export type RustVerdict = RustTest & { outcome: Outcome; note: string };
type RustJudgement = { verdicts: RustVerdict[]; unapplied: string[]; ran: number; total: number };

const key = (t: RustTest) => `${t.file} ${t.title}`;

const invalidRust = (t: RustTest, why: string): RustVerdict => ({
  ...t,
  outcome: "INVALID",
  note: ` (Rust: ${why}; needs a control)`,
});

/**
 * Applies `mutant` in the worktree `dir` and, only if its file really changed, runs `body`; then
 * undoes it, whatever happened. False when the patch left the file as it was, so nothing ran.
 */
async function withMutant(dir: string, mutant: Mutant, body: () => Promise<void>) {
  const path = join(dir, mutant.file);
  if (!existsSync(path)) return false;
  const original = readFileSync(path, "utf8");
  const patch = join(dir, "falsify-mutant.patch");
  writeFileSync(patch, mutant.patch);
  let applied = false;
  try {
    try {
      git(["apply", patch], dir);
    } catch {
      // Not applied: the file is unchanged, which is what decides.
    }
    applied = readFileSync(path, "utf8") !== original;
    if (applied) await body();
  } finally {
    git(["checkout", "--quiet", "--", mutant.file], dir);
  }
  if (readFileSync(path, "utf8") !== original) {
    throw new Error(`falsify: couldn't undo the mutant ${mutant.name}`);
  }
  return applied;
}

/**
 * Judges each new test by the mutants of the code the branch changed, in the worktree `dir`, at
 * HEAD: KILLED by the first mutant it fails on with a panic of its own, else INVALID. Each mutant
 * is applied, proved to have changed its file, run against the tests not yet killed, and undone,
 * and the run stops once every test is killed or MAX_MUTANTS have run.
 */
async function mutateRustTests(
  dir: string,
  top: string,
  range: string[],
  report: unknown,
  added: RustTest[],
  atBase: Set<string>,
): Promise<RustJudgement | undefined> {
  const diff = git(["diff", "-M", ...range, "--", "*.rs"], dir);
  if (diff === "") {
    const verdicts = added.map((t) => invalidRust(t, "no Rust source changed"));
    return { verdicts, unapplied: [], ran: 0, total: 0 };
  }
  const diffFile = join(dir, "falsify-rust.diff");
  writeFileSync(diffFile, diff);
  let mutants: Mutant[];
  let product: LineSpan[];
  try {
    mutants = parseMutants(await listMutants(dir, top, diffFile));
    product = productSpans(await listMutants(dir, top));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.error(
      `falsify: \`cargo-mutants mutants --list\` failed (${why}), so the new Rust tests can't be ` +
        `judged. Run it in the repository to see why; ${MUTANTS_HINT}`,
    );
    return undefined;
  }
  const targets = libtestTargets(report);
  writeFileSync(join(dir, "falsify-nextest.toml"), NEXTEST_PROFILE);

  // A crate's library and binaries share a target, so a new test named as one the base already
  // has there would be credited with the old test's failures.
  const counts = new Map<string, number>();
  for (const t of added) counts.set(key(t), (counts.get(key(t)) ?? 0) + 1);
  const shared = (t: RustTest) => (counts.get(key(t)) ?? 0) > 1;
  const runnable = added.filter((t) => filterable(t) && !atBase.has(key(t)) && !shared(t));
  const baseline = testEvents(
    runnable.length > 0 && mutants.length > 0 ? await runRustTests(dir, top, runnable) : "",
    targets,
  );
  const passed = new Set(baseline.filter((e) => e.event === "ok").map((e) => e.test));
  const broken = new Set(
    baseline.filter((e) => e.event !== "ok" && e.event !== "started").map((e) => e.test),
  );
  let pending = runnable.filter((t) => passed.has(key(t)) && !broken.has(key(t)));
  const killedBy = new Map<string, string>();
  const unapplied: string[] = [];
  let ran = 0;
  for (const mutant of mutants) {
    if (pending.length === 0 || ran === MAX_MUTANTS) break;
    const original = unmutate(mutant.patch, mutant.file);
    const failedUnder = async (tests: RustTest[]) => {
      const results = testEvents(await runRustTests(dir, top, tests), targets);
      const failed = new Set(
        results.filter((r) => failedOnAssertion(r, product, original)).map((r) => r.test),
      );
      return tests.filter((t) => failed.has(key(t)));
    };
    const applied = await withMutant(dir, mutant, async () => {
      ran += 1;
      const candidates = await failedUnder(pending);
      // Run once more, so a test that fails now and then isn't credited to whichever mutant it
      // happened to fail under.
      const confirmed = candidates.length > 0 ? await failedUnder(candidates) : [];
      for (const t of confirmed) killedBy.set(key(t), mutant.name);
      pending = pending.filter((t) => !killedBy.has(key(t)));
    });
    if (!applied) unapplied.push(mutant.name);
  }
  const capped =
    pending.length > 0 && ran === MAX_MUTANTS && ran + unapplied.length < mutants.length;
  const verdicts = added.map((t): RustVerdict => {
    const by = killedBy.get(key(t));
    if (by !== undefined) return { ...t, outcome: "KILLED", note: ` (by ${by})` };
    if (atBase.has(key(t))) return invalidRust(t, "the base has a test of that name in its crate");
    if (shared(t)) return invalidRust(t, "another new test in its crate has that name");
    if (!filterable(t)) return invalidRust(t, "its name can't be selected to run alone");
    if (mutants.length === 0) return invalidRust(t, "the change has no code to mutate");
    if (!passed.has(key(t)) || broken.has(key(t)))
      return invalidRust(t, "fails or doesn't run unmutated");
    return invalidRust(
      t,
      capped
        ? `no mutant failed it on an assertion within the first ${MAX_MUTANTS}`
        : "no mutant of the change failed it on an assertion",
    );
  });
  return { verdicts, unapplied, ran, total: mutants.length };
}

/**
 * The Rust tests HEAD has and the base hasn't, listed by nextest in a temporary worktree, each
 * judged by mutating the code the branch changed; or undefined, with the reason printed, when
 * they couldn't be listed or judged. Listing sees every test however it is declared: by
 * `#[test]`, proptest, or a macro of the crate's own. Mutants are applied only in that worktree,
 * which is removed on every way out, a signal included.
 */
async function judgeRustTests(top: string, base: string, head: string) {
  const dir = mkdtempSync(join(tmpdir(), WORKTREE_PREFIX));
  cleanup = () => {
    cleanup = undefined;
    removeWorktree(dir, top);
  };
  try {
    const cargoHome = process.env["CARGO_HOME"] ?? join(homedir(), ".cargo");
    const unsafeConfig = configFailures(outsideConfigs(dir, cargoHome), (path) =>
      existsSync(path) ? readFileSync(path, "utf8") : undefined,
    );
    if (unsafeConfig.length > 0) {
      console.error(
        "falsify: cargo would read this config while it runs the Rust tests in a temporary " +
          `worktree under ${tmpdir()}:\n${unsafeConfig.join("\n")}`,
      );
      return undefined;
    }
    addWorktree(dir, base, top);
    const before = await listRustTests(dir, top);
    git(["checkout", "--quiet", "--detach", head], dir);
    const after = await listRustTests(dir, top);
    if (before === undefined || after === undefined) {
      const where = before === undefined ? `the base, ${base.slice(0, 12)}` : "HEAD";
      console.error(
        `falsify: \`cargo-nextest nextest list\` failed at ${where}, so the Rust tests the ` +
          "branch adds are unknown. Run `pnpm test:rust` there to see why; if cargo-nextest is " +
          "missing, install it: cargo install --locked cargo-nextest@0.9.152",
      );
      return undefined;
    }
    const atBase = rustTestIds(before);
    const added = addedRustTests(atBase, rustTestIds(after));
    if (added.length === 0) return { verdicts: [], unapplied: [], ran: 0, total: 0 };
    return await mutateRustTests(dir, top, [base, head], after, added, new Set(atBase));
  } finally {
    cleanup?.();
  }
}

const USAGE = "usage: node scripts/falsify.ts [--base <ref>]";

/** The `--base` ref from the arguments, or undefined; throws on anything else. */
export function parseArgs(args: string[]): { base?: string } {
  if (args.length === 0) return {};
  const [flag, value, ...rest] = args;
  if (flag !== "--base" || value === undefined || value.startsWith("-") || rest.length > 0) {
    throw new Error(USAGE);
  }
  return { base: value };
}

/** True when any of the branch's commit messages records a control. */
export const hasControl = (messages: string): boolean => CONTROL_TRAILER.test(messages);

const resolves = (ref: string) => {
  try {
    git(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return true;
  } catch {
    return false;
  }
};

/**
 * The commit the branch is judged against: its merge base with `ref`, so commits that landed on
 * the base after the branch forked never count as the branch's change.
 */
function mergeBase(ref: string | undefined): string {
  const target = ref ?? (resolves("origin/main") ? "origin/main" : "main");
  return git(["merge-base", target, "HEAD"]).trim();
}

async function main(args: string[]): Promise<number> {
  let options: { base?: string };
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : USAGE);
    return 2;
  }
  const top = git(["rev-parse", "--show-toplevel"]).trim();
  const head = git(["rev-parse", "--verify", "HEAD^{commit}"]).trim();
  let base: string;
  try {
    base = mergeBase(options.base);
  } catch (error) {
    if (signalExitCode(error) !== undefined) throw error;
    console.error(
      `falsify: no merge base between HEAD and ${options.base ?? "origin/main or main"}. ` +
        "Pass --base <ref> naming the branch this one is based on; in a shallow clone, fetch " +
        "the full history first.",
    );
    return 2;
  }
  sweepStale(top);

  const messages = git(["log", "--format=%B", `${base}..${head}`]);
  const range = [base, head];

  const changes = parseNameStatus(git(["diff", "--name-status", "-M", ...range]));
  const tests = changes.filter((c) => c.status !== "D" && TEST_FILE.test(c.path));
  const targets = tests.flatMap((t) => {
    const paths = t.status === "R" && t.oldPath ? [t.oldPath, t.path] : [t.path];
    return newTitles(git(["diff", "-M", ...range, "--", ...paths]), t.path).map((title) => ({
      file: t.path,
      title,
    }));
  });
  let rust: RustJudgement = { verdicts: [], unapplied: [], ran: 0, total: 0 };
  if (changes.some((c) => RUST_INPUT.test(c.path) || RUST_INPUT.test(c.oldPath ?? ""))) {
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
    process.on("SIGHUP", handleSignal);
    try {
      const judged = await judgeRustTests(top, base, head);
      if (judged === undefined) return 1;
      rust = judged;
    } finally {
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      process.off("SIGHUP", handleSignal);
    }
  }
  const rustTests = rust.verdicts;
  if (targets.length === 0 && rustTests.length === 0) {
    console.log(`falsify: no new tests between ${base.slice(0, 12)} and HEAD`);
    return 0;
  }

  const reverts = changes.filter(
    (c) =>
      (REVERTIBLE.test(c.path) && !TEST_FILE.test(c.path)) ||
      (c.oldPath !== undefined && REVERTIBLE.test(c.oldPath) && !TEST_FILE.test(c.oldPath)),
  );
  const results: {
    file: string;
    title: string;
    outcome: Outcome;
    unrelated?: boolean;
    note?: string;
  }[] = [];

  results.push(...rustTests);
  if (targets.length === 0) {
    // Only Rust tests, judged already.
  } else if (reverts.length === 0) {
    for (const t of targets) results.push({ ...t, outcome: "INVALID" });
  } else {
    const dir = mkdtempSync(join(tmpdir(), WORKTREE_PREFIX));
    cleanup = () => {
      cleanup = undefined;
      removeWorktree(dir, top);
    };
    // SIGHUP too: an agent's tmux pane closing mid-run must not orphan the detached children.
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
    process.on("SIGHUP", handleSignal);
    try {
      addWorktree(dir, head, top);
      for (const c of reverts) {
        if (c.status === "A" || c.status === "C") rmSync(join(dir, c.path), { force: true });
        else if (c.status === "R" && c.oldPath) {
          rmSync(join(dir, c.path), { force: true });
          git(["checkout", base, "--", c.oldPath], dir);
        } else git(["checkout", base, "--", c.path], dir);
      }
      if (!(await install(dir))) {
        console.error(
          "falsify: couldn't install dependencies in the temporary worktree; run `pnpm install` " +
            "and retry.",
        );
        return 1;
      }
      const reportFile = join(dir, "falsify-report.json");
      await run(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          ...new Set(targets.map((t) => t.file)),
          "--reporter=json",
          `--outputFile=${reportFile}`,
        ],
        dir,
        VITEST_TIMEOUT_MS,
      );
      let report: VitestReport = { testResults: [] };
      try {
        const parsed: unknown = JSON.parse(readFileSync(reportFile, "utf8"));
        if (isReport(parsed)) report = parsed;
      } catch {
        // No report at all: the run never got going, so every target is INVALID.
      }
      // A passing test that imports none of the reverted files is a test of code the branch didn't
      // change (a characterization or property test): no verdict, so it needs a control.
      const revertedPaths = reverts.flatMap((c) => (c.oldPath ? [c.oldPath, c.path] : [c.path]));
      const packages = workspacePackages(dir);
      for (const t of targets) {
        const outcome = classify(report, t.file, t.title);
        const source = readFileSync(join(dir, t.file), "utf8");
        if (
          outcome === "SURVIVED" &&
          relatedReverts(t.file, source, revertedPaths, packages).length === 0
        ) {
          results.push({ ...t, outcome: "INVALID", unrelated: true });
        } else results.push({ ...t, outcome });
      }
    } finally {
      cleanup?.();
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      process.off("SIGHUP", handleSignal);
    }
  }

  console.log(`falsify: new tests run against the source at ${base.slice(0, 12)}`);
  for (const r of results) {
    const note = r.note ?? (r.unrelated ? " (passed; unrelated to the source change)" : "");
    console.log(`  ${r.outcome.padEnd(8)} ${r.file} › ${r.title}${note}`);
  }
  if (rust.total > 0) {
    console.log(
      `falsify: ${rust.ran} of the change's ${rust.total} Rust mutants run (at most ${MAX_MUTANTS})`,
    );
  }
  for (const name of rust.unapplied) {
    console.log(`  INVALID  mutant ${name} (its patch left the file unchanged; not run)`);
  }

  const survived = results.filter((r) => r.outcome === "SURVIVED");
  if (survived.length > 0) {
    console.error(
      "\nThese tests pass without the change, so they cannot detect it. Make each one assert the " +
        "behaviour the change introduces (bz-write-unit-test).",
    );
    return 1;
  }
  const uncontrolled = uncontrolledRustTests(
    rustTests.filter((t) => t.outcome !== "KILLED").map((t) => t.title),
    messages,
  );
  if (uncontrolled.length > 0) {
    console.error(
      "\nNo mutant of the change showed these Rust tests can fail, so each needs a control of its " +
        "own. Break the code by hand, confirm the test fails on its assertion, and record it in a " +
        "commit message on the branch, naming the test by its full path:\n" +
        uncontrolled
          .map((name) => `  Control: ${name}: <what you broke> -> <how it failed>`)
          .join("\n"),
    );
    return 1;
  }
  const invalid = results.filter((r) => r.outcome === "INVALID" && r.note === undefined);
  if (invalid.length > 0 && !hasControl(messages)) {
    console.error(
      reverts.length === 0
        ? "\nThis branch adds tests but no source change to revert."
        : "\nSome tests could not be judged by reverting (new symbols, tests unrelated to the " +
            "source change, unparsed titles, load errors or timeouts).",
    );
    console.error(
      "Break the code by hand, confirm each test fails on its assertion, and record it in a " +
        "commit message on the branch:\n  Control: <what you broke> -> <how the test failed>",
    );
    return 1;
  }
  return 0;
}

/** The exit code for a signal that killed a synchronous child (git), or undefined. */
export function signalExitCode(error: unknown): number | undefined {
  return typeof error === "object" && error !== null && "signal" in error
    ? exitCodeFor(error.signal)
    : undefined;
}

async function entry(): Promise<number> {
  try {
    return await main(process.argv.slice(2));
  } catch (error) {
    // Ctrl-C reaches a synchronous git child too, which dies of it and makes execFileSync throw.
    const code = signalExitCode(error);
    if (code === undefined) throw error;
    return code;
  }
}

if (isMain(import.meta)) process.exit(await entry());

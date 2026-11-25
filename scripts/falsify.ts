// Falsification harness (docs/standards/testing.md). It answers one question about the tests a
// branch adds: would they fail if the branch's source change were not there?
//
// It runs the branch's new tests against the base's version of the source (anything under an
// app's or package's src/ and TypeScript under scripts/, tests aside), in a throwaway worktree,
// and classifies each new test:
//   KILLED    it failed: the test depends on the change. Good.
//   SURVIVED  it passed without the change: it cannot detect the change. Not allowed. Only a test
//             that directly imports a reverted file, or runs one it names with `new URL`, can
//             survive; one that passes otherwise is unrelated to the source change and comes out
//             INVALID.
//   GUARDED   it survived, and fails under every break a `Guard:` commit gives it (below). Good.
//   INVALID   no verdict: it couldn't load, timed out, was skipped, its title couldn't be read or
//             isn't unique, it hadn't finished when its project's run left no report (falsify
//             says why; the tests that had are judged from what falsify-reporter.ts recorded as
//             each ended), or it passed but is unrelated to the source change; a branch that
//             adds tests without a source change also lands here, as does every test of a
//             brand-new symbol. Each INVALID
//             test needs a hand-run control, recorded as a trailer in a commit on the branch
//             that names it by its file and exact title:
//             `Control: <file> › <title>: <what you broke> -> <how the test failed>`
//             (one whose title couldn't be read, by its file and no other new test's title).
//
// A test that runs a Rust binary finds it in the repository's target/, which the worktree has
// none of. When a judged test, or anything it reaches through its imports (relative, or a
// workspace package's exports) or the source paths it names, names one as
// `target/<profile>/<name>`, the branch's Rust changes are reverted in the worktree too, each
// binary reached that the base has is built there with `cargo build`, and each one this
// run built is copied to the worktree's target/: the test runs the base's binaries, built with
// HEAD's toolchain and .cargo config. Only a name a crate's manifest declares counts. A
// test is related to a reverted file that a binary it names, or a file it imports directly names,
// was built from, as cargo's dep-info for it lists, or to that binary's crates' manifests. A test
// that fails while it reaches a binary the base doesn't build is INVALID: the binary's absence
// failed it. Binaries that won't build are no verdict: falsify fails, naming cargo's error.
//
// The judged tests run once per vitest project, as each project's moon task runs them: two
// projects' global setups in one process clash.
//
// A new test in a file tests/rust-daemon.txt names at HEAD holds both daemons, so it also runs
// against the Rust daemon built from the base (BAZHEN_TEST_DAEMON_BIN), when the branch reverted a
// file that daemon or a binary the test names was built from, or a Cargo manifest or the
// lockfile. It is KILLED when either run fails it, SURVIVED when either passes it while related
// to the change, else INVALID; the Rust run kills only on an assertion in the test, with every
// binary the test reaches or the branch adds built at the base. A base with no
// Rust daemon, or a Rust run that leaves such a test without a pass or a fail, fails falsify
// with no verdict: the TypeScript daemon alone can't see a change to the Rust one.
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
// A SURVIVED test that guards behaviour the base already has may land with a break of its own: a
// commit whose message holds fenced ```diff blocks against HEAD and a line
// `Guard: <file> › <title>: <what the break does>`. Before anything runs, each break is checked
// for shape and paths (text changes to the reverted source the test imports directly, none of it
// named as test support), must change some file's tokens, not only its comments or layout, and is
// applied to a scratch index, whose files join the signalling check.
// After the revert run, in the same worktree, the guarded tests run once at HEAD, where they must
// pass, then under each break alone on HEAD. A test is GUARDED only when it fails under each of
// its breaks on an AssertionError at its own frame; a pass, a timeout or a thrown error leaves it
// SURVIVED. A `Guard:` naming nothing judged, or a test that didn't survive, fails falsify.
//
// A test is new when its title is: HEAD's copy of the file has more tests with that title than
// the base's, read from both copies' test calls (scripts/test-calls.ts), however git's diff aligns
// them or the formatter lays them out. A test that moved, or whose body changed under its title,
// isn't new.
//
// A test renamed or moved to another test file, and otherwise unchanged, isn't new, and a commit
// trailer on the branch says so, with the old file as the base has it and the new as HEAD has it:
// `Renamed: <old file> › <old title> -> <new file> › <new title>`. It is left out only when it
// holds: the old file is the base path of a .test.ts file the branch changed, the old title is
// one test in it at the base and none in it at HEAD, no other trailer names that test the old
// test of another, the new title is one test in the new file at HEAD and none in it at the base,
// and the test's call is the base's token for token but for the title, comments and layout
// aside. Any other change, to its body, options or call, leaves it judged as new. A judged test
// that is a lost base test so moved or renamed is printed with the trailer it needs.
//
// The worktree's dependencies are installed, and built, as the checkout's are, so a test fails
// there only on the base's source. Under each test that failed, the first line of what failed it.
//
// Only committed work is judged: the worktree is checked out at HEAD, so commit before running.
// The temporary worktree is locked with this process's pid. A run killed before it could clean
// up leaves it behind, and the next run removes it once that pid is dead.
//
// Usage:
//   node scripts/falsify.ts [--base <ref>]
//   node scripts/falsify.ts --harness
// The branch is compared with its merge base with <ref>; <ref> defaults to origin/main, or main
// when there is no origin. `--harness` prints falsify's own files, one per line, for CI: a branch
// that changes one is judged by the base's falsify too, so a weakened falsify can't pass itself.

import { execFileSync, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseToml } from "smol-toml";
import { stripVTControlCharacters } from "node:util";
import { isAlive, rethrowUnsafe, signalGroup, spawnGroup } from "@bazhen/host-guard";
import { KILLS_ENV, OWN_SCOPE_FLAG } from "./capped.ts";
import {
  TEST_BUILD,
  configFailures,
  gateEnv,
  installCommand,
  outsideConfigs,
} from "./rust-gate.ts";
import { isMain } from "./is-main.ts";
import { inSandbox, judgeableHere, signallingWork } from "./falsify-signals.ts";
import { isSignallingSource } from "./signal-paths.ts";
import { RESULTS_FILE_ENV, UNFINISHED, partialReport } from "./falsify-reporter.ts";
import { DAEMON, LIST, SELECTOR, listed as listedFiles } from "./rust-daemon.ts";
import { codeTokens, testCalls, type TestCall } from "./test-calls.ts";
import {
  failedOnAssertion,
  inTestCode,
  filterable,
  unmutate,
  libtestTargets,
  nextestFilter,
  mutantListing,
  parseMutants,
  testEvents,
  type Mutant,
  type TestEvent,
  type RustTest,
} from "./rust-mutants.ts";

export type Outcome = "KILLED" | "SURVIVED" | "INVALID" | "GUARDED";
export type Change = { status: string; path: string; oldPath?: string };

const TEST_FILE = /(^|\/)[^/]+\.test\.tsx?$/;
// Falsify reads a file for tests only when its path is plain TypeScript. A rename git detects pairs
// files by content whatever their extension, and JSX, MDX and the like, read as TypeScript, could
// hide or fake a test call.
const readsAsTypeScript = (path: string) => /\.[cm]?ts$/.test(path);
const ONLY_TYPESCRIPT = "falsify reads tests only from .ts, .mts and .cts files";
const REVERTIBLE = /^(?:(?:apps|packages)\/[^/]+\/src\/|scripts\/.+\.tsx?$)/;
// What can change the set of Rust tests, or what a Rust binary does: a crate's files, or the
// workspace's manifest and lockfile.
const RUST_INPUT = /^(?:crates\/|Cargo\.(?:toml|lock)$)/;
// The workspace's manifests and lockfile, and each crate's manifest.
const CARGO_MANIFEST = /^(?:Cargo\.(?:toml|lock)|crates\/[^/]+\/Cargo\.toml)$/;
// The target folders a test runs a binary from, each with the cargo profile that fills it.
const PROFILES: Readonly<Record<string, string>> = {
  debug: "dev",
  release: "release",
  "release-holder": "release-holder",
};
// A string naming a binary in the repository's target/, as a test joins to the repository's root.
const TARGET_STRING = /["'`](target\/[\w-]+\/[\w-]+)["'`]/g;
const IN_TARGET = /^target\/([\w-]+\/[\w-]+)$/;
// A source file named by its path from the repository's root, as a test names a program it runs.
const ROOT_SOURCE = /["'`]((?:apps|packages|scripts|tests)\/[\w./-]+\.[cm]?tsx?)["'`]/g;
export const WORKTREE_PREFIX = "bz-falsify-";
const LOCK_REASON = /^bz-falsify pid=(\d+)$/;
export const INSTALL_TIMEOUT_MS = 120_000;
// Node's timers fire at once for a delay they can't hold.
const TIMER_MAX_MS = 2 ** 31 - 1;

/**
 * The limit an environment variable sets, in ms, or `fallback` when it is unset or empty. Throws
 * on anything but a whole number from 1 to the most a timer holds, which would stop every run at
 * once.
 */
export function timeoutFrom(name: string, value: string | undefined, fallback: number): number {
  if (value === undefined || value === "") return fallback;
  const ms = /^\d+$/.test(value) ? Number(value) : NaN;
  if (!(ms >= 1 && ms <= TIMER_MAX_MS)) {
    throw new Error(`${name} is a whole number of ms from 1 to ${TIMER_MAX_MS}, not "${value}"`);
  }
  return ms;
}

// Each vitest run's limit, one project's judged files; a test of the limit itself sets a shorter
// one.
const VITEST_TIMEOUT_MS = timeoutFrom(
  "FALSIFY_VITEST_TIMEOUT_MS",
  process.env["FALSIFY_VITEST_TIMEOUT_MS"],
  300_000,
);
const CARGO_TIMEOUT_MS = 900_000;
// The most mutants run for one branch. A count, not a time budget, so a verdict is the same on
// every machine; a hook-crate mutant builds and runs in under a second.
const MAX_MUTANTS = 100;
// Each Rust test run's limit, build included; a test of the limit itself sets a shorter one.
const MUTANT_TIMEOUT_MS = timeoutFrom(
  "FALSIFY_RUST_TIMEOUT_MS",
  process.env["FALSIFY_RUST_TIMEOUT_MS"],
  300_000,
);
// nextest's libtest JSON is experimental; the version pins its shape.
const LIBTEST_JSON_VERSION = "0.1";
const KILL_GRACE_MS = 2000;
// A mutant's nextest run runs under capped in a scope of its own. Stopped, capped passes SIGTERM to
// its scope, kills what is left 10 s later, and stops the scope; killed before that, it leaves the
// scope, and what a hung test started in it, running to the scope's time cap.
const CAPPED_STOP_GRACE_MS = 30_000;
// The falsify task's own cap: inside its scope, capped holds a run of its own to 90% of that. The
// run's scope is beside the task's, which meanwhile holds only falsify and capped, waiting on it.
const MUTANT_RUN_MEMORY = "8G";
// Runs the Rust tests without a capped scope of their own, saving its half a second, for tests of
// falsify's judging. It can't hide a leftover from the falsify task's run: what an uncontained
// run leaves stays where that run counts, as far as it can count (its scope under systemd, only its
// process group elsewhere, which a process in a session of its own escapes either way).
const UNCONTAINED_ENV = "BZ_FALSIFY_UNCONTAINED";
// The most a mutant's run's time cap may be: a watchdog's timer holds no more.
const MAX_BACKSTOP_S = Math.floor(TIMER_MAX_MS / 1000);

const counted = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;
const secondsSince = (start: number) => Math.round((performance.now() - start) / 1000);

// Beside this file, never the worktree's copy, which the branch's revert may have changed or removed.
const REPORTER = fileURLToPath(new URL("falsify-reporter.ts", import.meta.url));
const CAPPED = fileURLToPath(new URL("capped.ts", import.meta.url));
const JUDGING = "BZ_FALSIFY_JUDGING";

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

/**
 * The caller's environment without what would point a command elsewhere: git's location
 * variables, and the daemon the api suite starts, which only the Rust daemon's run sets.
 */
export function isolatedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const name of GIT_LOCATION_VARS) delete env[name];
  delete env[SELECTOR];
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

/**
 * Moves to the repository's root, as every path falsify and falsify-base read is the root's,
 * whatever folder they were run from. A relative TMPDIR or CARGO_HOME is resolved first, so it
 * still names the folder the caller meant.
 */
export function workFromRoot(top: string): void {
  for (const name of ["TMPDIR", "CARGO_HOME"]) {
    const value = process.env[name];
    if (value !== undefined && value !== "" && !isAbsolute(value))
      process.env[name] = resolve(value);
  }
  process.chdir(top);
}

/**
 * A file as the commit `rev` has it, or undefined where it has none. Any other failure throws, so
 * an unreadable file is never taken for an absent one.
 */
function fileAt(rev: string, path: string): string | undefined {
  if (git(["ls-tree", "-z", "--full-tree", rev, "--", path]) === "") return undefined;
  return git(["cat-file", "blob", `${rev}:${path}`]);
}

/**
 * Whether a changed path is source the revert check puts back as the base had it: anything under
 * an app's or package's `src/`, and TypeScript under `scripts/`, but never a test. These are the
 * folders the sibling-test rule in check-standards.ts reads source from.
 */
export const isRevertible = (path: string): boolean =>
  REVERTIBLE.test(path) && !TEST_FILE.test(path);

/**
 * Committed files a generator writes, by the sources it generates them from, each a path or a
 * folder ending in `/`. When any of a generator's sources is reverted, the outputs the branch
 * changed are reverted with it, so a test that reads an output sees what the base generated.
 */
const GENERATED: readonly { sources: readonly string[]; outputs: readonly string[] }[] = [
  { sources: ["scripts/lint-config.ts"], outputs: [".oxlintrc.json"] },
  {
    sources: ["scripts/protocol-schema.ts", "packages/protocol/src/"],
    outputs: ["packages/protocol/fixtures/"],
  },
  // `cargo xtask schema` publishes the schema, and writes the protocol id and the web's zod, from
  // the types of the Rust protocol and the holder's bodies. A crate is reverted only for a test
  // that runs a binary, so only then are these. The zod and the TypeScript id, under src/gen/, are
  // source the check reverts whenever it reverts TypeScript, so they are listed too: one reverted
  // alone would leave an id that no longer hashes the schema beside it.
  {
    sources: [
      "packages/protocol/src/gen/",
      "crates/bazhen-xtask/src/schema/",
      "crates/bazhen-protocol/",
      "crates/bazhen-holder-proto/",
    ],
    outputs: [
      "packages/protocol/schema/",
      "packages/protocol/src/gen/",
      "crates/bazhen-protocol/src/id.rs",
    ],
  },
];

const within = (path: string, entries: readonly string[]) =>
  entries.some((e) => path === e || (e.endsWith("/") && path.startsWith(e)));

const pathsOf = (c: Change) => (c.oldPath === undefined ? [c.path] : [c.path, c.oldPath]);

/**
 * The changes the revert check puts back as the base had them: the revertible source, and the
 * changed outputs of every generator whose source that includes. When `rust`, a judged test runs
 * a Rust binary, so the Rust workspace is put back too, and the binaries built from it are the
 * base's.
 */
export function revertsOf(changes: Change[], { rust = false } = {}): Change[] {
  const reverts = (path: string) => isRevertible(path) || (rust && RUST_INPUT.test(path));
  const source = changes.filter((c) => pathsOf(c).some(reverts));
  const reverted = source.flatMap(pathsOf);
  const outputs = GENERATED.filter((g) => reverted.some((p) => within(p, g.sources))).flatMap(
    (g) => g.outputs,
  );
  return changes.filter((c) => source.includes(c) || pathsOf(c).some((p) => within(p, outputs)));
}

export function parseNameStatus(out: string): Change[] {
  const fields = out.split("\0");
  const changes: Change[] = [];
  for (let i = 0; i < fields.length;) {
    const status = fields[i]?.[0] ?? "";
    if (status === "") break;
    if (status === "R" || status === "C") {
      changes.push({ status, oldPath: fields[i + 1] ?? "", path: fields[i + 2] ?? "" });
      i += 3;
    } else {
      changes.push({ status, path: fields[i + 1] ?? "" });
      i += 2;
    }
  }
  return changes;
}

const unparsedIn = (file: string) => `<unparsed test in ${file}>`;

/** What a test is counted by: its title, or the tokens of one that can't be read. */
const countedBy = (t: TestCall) => (t.title === undefined ? `\0${t.titleTokens}` : t.title);

/**
 * The titles of the tests in a test file that HEAD has more of than the base, read from both
 * sides' test calls (`testCalls`), so a test that only moved, or whose body or layout changed under
 * its title, isn't new. A test whose title can't be read (interpolated, a variable) counts by its
 * title's tokens, and each new one adds an `<unparsed test in FILE>` marker, which classifies as
 * INVALID and so forces a Control trailer. So does a side that can't be read at all, with why,
 * and a file whose path on either side isn't plain TypeScript. `file` is the path at HEAD and
 * `counterpart` the one git pairs it with at the base, as `ends.new` gives them.
 */
export function changedTests({ file, base, head = "", counterpart = file }: FileSides): {
  titles: string[];
  unreadable?: string;
} {
  const unread = [file, counterpart].find((p) => !readsAsTypeScript(p));
  if (unread !== undefined) {
    return {
      titles: [unparsedIn(file)],
      unreadable:
        unread === file ? ONLY_TYPESCRIPT : `${ONLY_TYPESCRIPT}, and its base copy is ${unread}`,
    };
  }
  const before = base === undefined ? [] : testCalls(base);
  if (typeof before === "string") {
    return { titles: [unparsedIn(file)], unreadable: `the base's copy has ${before}` };
  }
  const after = testCalls(head);
  if (typeof after === "string") {
    return { titles: [unparsedIn(file)], unreadable: `HEAD's copy has ${after}` };
  }
  const left = new Map<string, number>();
  for (const t of before) left.set(countedBy(t), (left.get(countedBy(t)) ?? 0) + 1);
  const titles = new Set<string>();
  for (const t of after) {
    const count = left.get(countedBy(t)) ?? 0;
    left.set(countedBy(t), count - 1);
    if (count <= 0) titles.add(t.title ?? unparsedIn(file));
  }
  return { titles: [...titles] };
}

const RENAMED_TRAILER = /^Renamed: (.+)$/gm;
const ARROW = " -> ";
const IN_FILE = " › ";
const RENAMED_FORM = "<old file> › <old title> -> <new file> › <new title>";
const MOVED_OR_RENAMED =
  "Some are a test the base has, moved to another file or under a new title. If that is all " +
  "they are, say so in a commit message on the branch:";

export type TestRef = { file: string; title: string };
export type RenameReading = { from: TestRef; to: TestRef };
export type RenameTrailer = { trailer: string; readings: RenameReading[] };

/** `<file> › <title>`, split at its first `›`, since a path holds none and a title may. */
function testRef(side: string): TestRef | undefined {
  const at = side.indexOf(IN_FILE);
  const title = side.slice(at + IN_FILE.length);
  return at <= 0 || title === "" ? undefined : { file: side.slice(0, at), title };
}

/**
 * Each `Renamed: <old file> › <old title> -> <new file> › <new title>` trailer in the branch's
 * messages, once, with each reading of it: split at each of its arrows in turn, since a title
 * could hold one. Only a reading the rename check accepts applies. A trailer with no reading
 * names no file on one side.
 */
export function renameTrailers(messages: string): RenameTrailer[] {
  const lines = new Set(
    [...messages.matchAll(RENAMED_TRAILER)].map(([, line = ""]) => line.trimEnd()),
  );
  return [...lines].map((trailer) => {
    const readings: RenameReading[] = [];
    for (let at = trailer.indexOf(ARROW); at !== -1; at = trailer.indexOf(ARROW, at + 1)) {
      const from = testRef(trailer.slice(0, at));
      const to = testRef(trailer.slice(at + ARROW.length));
      if (from !== undefined && to !== undefined) readings.push({ from, to });
    }
    return { trailer, readings };
  });
}

export const renamedLine = ({ from, to }: RenameReading): string =>
  `Renamed: ${from.file} › ${from.title} -> ${to.file} › ${to.title}`;

type TestBlock = { title: string; body: string };

const titled = (tests: TestBlock[], title: string) => tests.filter((t) => t.title === title);

/** The tests in a file with a readable title, or why the file can't be read. */
function testsIn(source: string): TestBlock[] | string {
  const calls = testCalls(source);
  return typeof calls === "string"
    ? calls
    : calls.flatMap(({ title, body }) => (title === undefined ? [] : [{ title, body }]));
}

/**
 * The test files a test can have moved out of, or been renamed in, by their paths at the base:
 * those the branch changed, deleted or renamed. Not one whose path on either side isn't plain
 * TypeScript: falsify can't read its tests, so JSX could hide the one a trailer says is gone.
 */
export function leavableTestFiles(changes: Change[]): string[] {
  return changes.flatMap((c) => {
    const paths = [c.oldPath || c.path, c.path];
    return c.status !== "A" && paths.every((p) => TEST_FILE.test(p) && readsAsTypeScript(p))
      ? [paths[0] ?? ""]
      : [];
  });
}

/**
 * A test file's text at the base and at HEAD, undefined where that side has no such file.
 * `counterpart` is its path on the side `file` doesn't name, when git renamed it.
 */
export type FileSides = {
  file: string;
  base: string | undefined;
  head: string | undefined;
  counterpart?: string;
};
export type RenameEnd = FileSides & { title: string };

/**
 * Why the test `to` isn't the base's test `from`, moved to another file or given a new title,
 * or undefined when it is. `from` carries the old file at the base and the file git pairs it with
 * at HEAD; `to` the new file at HEAD and the file git pairs it with at the base. It is a rename
 * only when the old title is one test in the old file at the base and none in it at HEAD, the new
 * title one in the new file at HEAD and none in it at the base, and the test's block is the base's
 * with only its title changed. A file whose path on either side isn't plain TypeScript is never
 * read.
 */
export function renameRefusal(from: RenameEnd, to: RenameEnd): string | undefined {
  const oldAtHead = from.counterpart ?? from.file;
  const newAtBase = to.counterpart ?? to.file;
  const unread = [from.file, oldAtHead, newAtBase, to.file].find((p) => !readsAsTypeScript(p));
  if (unread !== undefined) return `${unread}: ${ONLY_TYPESCRIPT}`;
  const read: TestBlock[][] = [];
  for (const [text, copy] of [
    [from.base, `the base's copy of ${from.file}`],
    [from.head, `HEAD's copy of ${oldAtHead}`],
    [to.base, `the base's copy of ${newAtBase}`],
    [to.head, `HEAD's copy of ${to.file}`],
  ] as const) {
    const tests = testsIn(text ?? "");
    if (typeof tests === "string") return `${copy} has ${tests}`;
    read.push(tests);
  }
  const [oldBefore = [], oldAfter = [], newBefore = [], newAfter = []] = read;
  const old = titled(oldBefore, from.title);
  if (old.length !== 1) {
    return old.length === 0
      ? `the base has no test "${from.title}" in ${from.file}`
      : `the base has ${old.length} tests "${from.title}" in ${from.file}`;
  }
  if (titled(oldAfter, from.title).length > 0) {
    return `HEAD still has a test "${from.title}" in ${oldAtHead}`;
  }
  if (titled(newBefore, to.title).length > 0) {
    return `the base already has a test "${to.title}" in ${newAtBase}`;
  }
  const now = titled(newAfter, to.title);
  if (now.length !== 1) {
    return now.length === 0
      ? `HEAD has no test "${to.title}" in ${to.file}`
      : `HEAD has ${now.length} tests "${to.title}" in ${to.file}`;
  }
  return old[0]?.body === now[0]?.body
    ? undefined
    : `"${to.title}" isn't "${from.title}" with only its title changed`;
}

/**
 * The one test of the base's in `olds`, the test files a move or rename could have left, that the
 * test `to` is, moved or under a new title, by the rule `renameRefusal` applies, or undefined.
 */
export function renamedFrom(to: RenameEnd, olds: FileSides[]): TestRef | undefined {
  const now = testsIn(to.head ?? "");
  const body = typeof now === "string" ? undefined : titled(now, to.title)[0]?.body;
  if (body === undefined) return undefined;
  const found = olds.flatMap((old) => {
    const before = testsIn(old.base ?? "");
    if (typeof before === "string") return [];
    return before
      .filter((t) => t.body === body && renameRefusal({ ...old, title: t.title }, to) === undefined)
      .map((t) => ({ file: old.file, title: t.title }));
  });
  return found.length === 1 ? found[0] : undefined;
}

/**
 * The path a file has on the other side of the branch, at HEAD for a base path and at the base for
 * a HEAD path. Only a rename git reports gives it another path.
 */
export function counterparts(changes: Change[]): {
  atHead: (path: string) => string;
  atBase: (path: string) => string;
} {
  const renames = changes.flatMap((c) =>
    c.status === "R" && c.oldPath ? [[c.oldPath, c.path]] : [],
  );
  const toHead = new Map(renames.map(([old = "", now = ""]) => [old, now]));
  const toBase = new Map(renames.map(([old = "", now = ""]) => [now, old]));
  return { atHead: (p) => toHead.get(p) ?? p, atBase: (p) => toBase.get(p) ?? p };
}

const keyOf = (t: TestRef) => `${t.file}\0${t.title}`;

/**
 * Which of the branch's new tests `found` the `Renamed:` trailers show are a base test, moved or
 * under a new title, and why each trailer that applies to none doesn't. `olds` holds the files of
 * `leavableTestFiles`, by their exact paths at the base; `news` gives a new test's file. A base
 * test named the old test of two tests is neither's, so a trailer per copy can't leave out a copy.
 */
export function appliedRenames(
  found: TestRef[],
  trailers: RenameTrailer[],
  olds: ReadonlyMap<string, FileSides>,
  news: (file: string) => FileSides,
): { renamed: RenameReading[]; refused: Map<string, string> } {
  const refusals = new Map<string, string>();
  const claims: (RenameReading & { trailer: string })[] = [];
  for (const to of found) {
    for (const { trailer, readings } of trailers) {
      for (const { from } of readings.filter((r) => keyOf(r.to) === keyOf(to))) {
        const old = olds.get(from.file);
        const why =
          old === undefined
            ? `${from.file} isn't the base path of a .test.ts file the branch changed`
            : renameRefusal({ ...old, title: from.title }, { ...news(to.file), title: to.title });
        if (why === undefined) claims.push({ trailer, from, to });
        else if (!refusals.has(trailer)) refusals.set(trailer, why);
      }
    }
  }
  const claimants = new Map<string, Set<string>>();
  for (const { from, to } of claims) {
    claimants.set(keyOf(from), (claimants.get(keyOf(from)) ?? new Set()).add(keyOf(to)));
  }
  const applied = new Set<string>();
  const renamed = new Map<string, RenameReading>();
  for (const { trailer, from, to } of claims) {
    if ((claimants.get(keyOf(from))?.size ?? 0) > 1) {
      refusals.set(
        trailer,
        `${from.file} › ${from.title} is named the old test of more than one test`,
      );
      continue;
    }
    applied.add(trailer);
    if (!renamed.has(keyOf(to))) renamed.set(keyOf(to), { from, to });
  }
  const refused = new Map<string, string>();
  for (const { trailer, readings } of trailers) {
    if (applied.has(trailer)) continue;
    refused.set(
      trailer,
      readings.length === 0
        ? `it names no file: write it as ${RENAMED_FORM}`
        : (refusals.get(trailer) ?? "the branch adds no test of that name"),
    );
  }
  return { renamed: [...renamed.values()], refused };
}

/**
 * The new tests left to judge once `appliedRenames` leaves out those the trailers show are a base
 * test moved or renamed, each printed, as is each trailer that applies to none, with why.
 */
function leaveOutRenames(
  found: TestRef[],
  trailers: RenameTrailer[],
  olds: ReadonlyMap<string, FileSides>,
  news: (file: string) => FileSides,
): TestRef[] {
  const { renamed, refused } = appliedRenames(found, trailers, olds, news);
  for (const { from, to } of renamed) {
    console.log(
      `falsify: RENAMED ${to.file} › ${to.title} (was ${from.file} › ${from.title}), not judged`,
    );
  }
  for (const [trailer, why] of refused) {
    console.log(`falsify: Renamed: ${trailer} doesn't apply (${why}), so its test is judged`);
  }
  const left = new Set(renamed.map(({ to }) => keyOf(to)));
  return found.filter((t) => !left.has(keyOf(t)));
}

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
const controlSubjects = (messages: string) =>
  [...messages.matchAll(CONTROL_SUBJECT)].map(([, subject = ""]) => subject);

/**
 * The Rust tests no `Control:` trailer names. A trailer names a test when the part before its
 * `->` holds the test's full path (`module::name`) as a whole word. The target isn't part of it,
 * so one trailer covers the same path added in two crates on one branch.
 */
export function uncontrolledRustTests(names: string[], messages: string): string[] {
  const subjects = controlSubjects(messages);
  return names.filter((name) => {
    const named = new RegExp(`(?<!\\w|::)${escapeRegExp(name)}(?!\\w|::)`);
    return !subjects.some((subject) => named.test(subject));
  });
}

const DESCRIBE = "(?:(?:(?!: | › ).)+ › )*";

/**
 * The one test a `Control:` trailer's subject names, of the branch's new TypeScript tests. The
 * subject starts with a test's path and ` › `, then any `describe` names each ending ` › ` and
 * holding no `: `, then its exact title, ending at a `: ` or at the subject's end. Of the titles
 * that fit, it names the longest. A subject that starts with the path but fits no title names the
 * file's test whose title couldn't be read.
 */
function namedBy<T extends { file: string; title: string }>(subject: string, tests: T[]) {
  const inFile = tests.filter((t) => subject.startsWith(`${t.file} › `));
  const fitting = inFile.filter(
    (t) =>
      t.title !== unparsedIn(t.file) &&
      new RegExp(
        `^${escapeRegExp(t.file)} › ${DESCRIBE}${escapeRegExp(t.title)}(?=:(?: |$)|$)`,
      ).test(subject),
  );
  const longest = fitting.toSorted((a, b) => b.title.length - a.title.length)[0];
  return longest ?? inFile.find((t) => t.title === unparsedIn(t.file));
}

/**
 * The INVALID TypeScript tests, of the branch's new ones, no `Control:` trailer names. Each
 * trailer names at most one test (`namedBy`); the part before its last `->` is what it names.
 */
export function uncontrolledTests<T extends { file: string; title: string; outcome: Outcome }>(
  tests: T[],
  messages: string,
): T[] {
  const named = new Set(
    controlSubjects(messages).flatMap((subject) => {
      const test = namedBy(subject, tests);
      return test === undefined ? [] : [keyOf(test)];
    }),
  );
  return tests.filter((t) => t.outcome === "INVALID" && !named.has(keyOf(t)));
}

/** The trailer line a test no control names needs, to fill in. */
export function controlLine(t: { file: string; title: string }): string {
  const title = t.title === unparsedIn(t.file) ? "<the test's title>" : t.title;
  return `Control: ${t.file} › ${title}: <what you broke> -> <how it failed>`;
}

const HUNK_HEAD = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/;

/**
 * A fenced block's lines as `git apply` should read them. Git's message cleanup strips the space a
 * blank context line starts with. Inside a hunk `git apply` still reads the empty line as blank
 * context, but at the end of the block it can't tell one from the blank lines before the fence,
 * and a hunk short of its trailing context only matches at the end of a file. So the empty lines
 * the last hunk's header says it still lacks are context again, and the rest go.
 */
export function closedBlock(lines: readonly string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  const kept = lines.slice(0, end);
  let start = -1;
  for (let i = kept.length - 1; i >= 0 && start < 0; i--) {
    if (HUNK_HEAD.test(kept[i] ?? "")) start = i;
  }
  if (start < 0) return kept;
  const [, before = "1", after = "1"] = HUNK_HEAD.exec(kept[start] ?? "") ?? [];
  let old = 0;
  let next = 0;
  for (const line of kept.slice(start + 1)) {
    if (line === "" || line.startsWith(" ")) {
      old++;
      next++;
    } else if (line.startsWith("-")) old++;
    else if (line.startsWith("+")) next++;
  }
  const lacking = Math.min(Number(before) - old, Number(after) - next, lines.length - end);
  return [...kept, ...Array.from({ length: Math.max(lacking, 0) }, () => " ")];
}

/** A commit's guards: the subjects of its `Guard:` lines, and the break they share. */
export type Guard = { commit: string; subjects: string[]; patch: string };

export const GUARD_FORM = "Guard: <file> › <title>: <what the break does>";
const GUARD_LINE = /^Guard: (.+)$/;
const FENCE_OPEN = "```diff";
const FENCE_CLOSE = "```";
const MAX_GUARD_BREAKS = 10;

/**
 * Each commit's guards, from `git log --format=%H%x00%B%x00`. A commit's break is every fenced
 * ```` ```diff ```` block of its message, in order (`closedBlock`); one left open is no block.
 */
export function guardsOf(log: string): Guard[] {
  const fields = log.split("\0");
  const guards: Guard[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const commit = (fields[i] ?? "").trim();
    if (commit === "") continue;
    const subjects: string[] = [];
    const blocks: string[][] = [];
    let block: string[] | undefined;
    for (const line of (fields[i + 1] ?? "").split("\n")) {
      if (block === undefined) {
        if (line === FENCE_OPEN) block = [];
        else {
          const subject = GUARD_LINE.exec(line)?.[1];
          if (subject !== undefined) subjects.push(subject);
        }
      } else if (line === FENCE_CLOSE) {
        blocks.push(closedBlock(block));
        block = undefined;
      } else block.push(line);
    }
    // A block left open is no break, and its lines are the message's again.
    for (const line of block ?? []) {
      const subject = GUARD_LINE.exec(line)?.[1];
      if (subject !== undefined) subjects.push(subject);
    }
    if (subjects.length === 0) continue;
    const patch = blocks.flat();
    guards.push({ commit, subjects, patch: patch.length === 0 ? "" : `${patch.join("\n")}\n` });
  }
  return guards;
}

/**
 * Why a break may not change `path`, for a test whose related reverts are `related`; undefined
 * when it may. A break of anything but the change the test was judged against, or of what the
 * test feeds itself through, could fail it without the guarded code being touched.
 */
export function brokenPathRefusal(path: string, related: readonly string[]): string | undefined {
  if (/(?:^|\/)testing\//.test(path) || /fixture/i.test(posix.basename(path))) {
    return `${path} is test support`;
  }
  if (!related.includes(path)) {
    return `${path} isn't source the branch changed that the test imports`;
  }
  return undefined;
}

/** Whether `git apply --summary` says a patch does more than modify files' text. */
export const reshapes = (summary: string): boolean => summary.trim() !== "";

/** The paths `git apply --numstat -z` names, or undefined when one is binary or renamed. */
export function numstatPaths(numstat: string): string[] | undefined {
  const paths: string[] = [];
  const fields = numstat.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i] ?? "";
    if (field === "") continue;
    const stat = /^(-|\d+)\t(-|\d+)\t(.*)$/.exec(field);
    if (stat === null) return undefined;
    if (stat[1] === "-" || stat[3] === "") return undefined;
    paths.push(stat[3] ?? "");
  }
  return paths;
}

/** Whether a test's call in `source`, under `title`, is written with `.fails`. */
export function isFailsTest(source: string, title: string): boolean {
  const calls = testCalls(source);
  if (typeof calls === "string") return false;
  return calls.some((c) => {
    if (c.title !== title) return false;
    const parsed: unknown = JSON.parse(c.body);
    const tokens = Array.isArray(parsed)
      ? parsed.filter((token): token is string => typeof token === "string")
      : [];
    const head = tokens.slice(0, Math.max(tokens.indexOf("("), 0));
    return head.includes("fails");
  });
}

/**
 * Whether a failure is an assertion of the test's own: an `AssertionError`, chai's or
 * `node:assert`'s, thrown where the test file's code is the first frame outside node and its
 * modules. A TypeError, a throw at load or a helper's throw isn't.
 */
export const failedOnOwnAssertion = (messages: readonly string[], file: string): boolean =>
  messages.some((m) => /^\s*AssertionError\b/.test(m) && failedInTest(m, file));

export type VitestReport = {
  testResults: {
    name: string;
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

/**
 * A JSON file a command was to write: what it holds, or that it is missing, can't be read (with
 * the error's code) or isn't JSON.
 */
export type Written =
  | { kind: "json"; value: unknown }
  | { kind: "missing" }
  | { kind: "unreadable"; code: string }
  | { kind: "not JSON" };

function readWritten(path: string): Written {
  if (!existsSync(path)) return { kind: "missing" };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : String(error);
    return { kind: "unreadable", code };
  }
  try {
    return { kind: "json", value: JSON.parse(text) as unknown };
  } catch {
    return { kind: "not JSON" };
  }
}

/** What falsify's reporter recorded at `path`: nothing when it wrote none, or can't be read. */
function readRecorded(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Why a vitest run, or its listing, left nothing falsify can use: how it ended when that wasn't
 * an exit of its own with code 0, else what is wrong with what it wrote. A run that times out ends
 * by falsify's signal, so its cap is named rather than that signal.
 */
export function noOutputReason(
  ended: Omit<Ran, "ok">,
  written: Written,
  noun: "report" | "listing",
  capMs: number,
): string {
  if (ended.timedOut)
    return `it timed out after ${capMs / 1000} s, falsify's cap on one vitest run`;
  if (ended.error !== undefined) return `it couldn't start: ${ended.error}`;
  if (ended.signal !== null) return `it was stopped by ${ended.signal}`;
  if (ended.code !== 0) return `it exited with code ${ended.code}`;
  if (written.kind === "missing") return `it wrote no ${noun}`;
  if (written.kind === "unreadable") return `its ${noun} couldn't be read (${written.code})`;
  if (written.kind === "not JSON") return `its ${noun} isn't JSON`;
  return `its ${noun} isn't a vitest ${noun}`;
}

/**
 * The test files a `vitest list --filesOnly --json=<file>` listing names, by the project each runs
 * in, relative to whichever of `roots` (the worktree, and its real path) holds them. Throws on
 * anything that isn't such a listing, or names a file outside them.
 */
export function projectsOf(listing: unknown, roots: readonly string[]): Map<string, string[]> {
  if (!Array.isArray(listing)) throw new Error("not a vitest file listing");
  const projects = new Map<string, string[]>();
  for (const listed of listing as unknown[]) {
    const file =
      typeof listed === "object" && listed !== null && "file" in listed ? listed.file : "";
    const project =
      typeof listed === "object" && listed !== null && "projectName" in listed
        ? listed.projectName
        : undefined;
    const root = roots.find((r) => typeof file === "string" && file.startsWith(`${r}/`));
    if (typeof file !== "string" || typeof project !== "string" || root === undefined) {
      throw new Error("not a vitest file listing of the worktree");
    }
    projects.set(project, [...(projects.get(project) ?? []), file.slice(root.length + 1)]);
  }
  return projects;
}

/** The report's one result for the test, or undefined when it has none or several. */
function resultOf(report: VitestReport, file: string, title: string) {
  const suite = report.testResults.find((r) => r.name.endsWith(file));
  const matches = suite?.assertionResults.filter((a) => a.title === title) ?? [];
  return matches.length === 1 ? matches[0] : undefined;
}

/** Whether the report has one result for the test, and the test ran to an end. */
export function finishedIn(report: VitestReport, file: string, title: string): boolean {
  const test = resultOf(report, file, title);
  return test !== undefined && test.status !== UNFINISHED;
}

export function classify(report: VitestReport, file: string, title: string): Outcome {
  const test = resultOf(report, file, title);
  if (test === undefined) return "INVALID";
  if (test.status === "passed") return "SURVIVED";
  if (test.failureMessages.some((m) => /Test timed out/.test(m))) return "INVALID";
  return test.status === "failed" ? "KILLED" : "INVALID";
}

/** A judged test's verdict, with what is printed beside it. */
export type Judged = TestRef & {
  outcome: Outcome;
  unrelated?: boolean;
  unbuilt?: string[];
  note?: string;
  noReport?: string | undefined;
  failure?: string | undefined;
  /** Why a guard naming a surviving test didn't make it GUARDED. */
  guard?: string;
  /** The breaks a GUARDED test failed under, each by its commit, with what failed it. */
  guardedBy?: { commit: string; failure: string | undefined }[];
};

/** The Rust daemon's binary, as `<profile>/<name>` under target/. */
const RUST_DAEMON = DAEMON.slice("target/".length);

/**
 * Why a listed test has no pass or fail in its run on the Rust daemon: the run left it unfinished
 * or without a result, or it ended another way, as skipped. Undefined when it passed or failed.
 */
export function unrunReason(
  daemonRun: { report: VitestReport; unreported: ReadonlyMap<string, string> },
  t: TestRef,
): string | undefined {
  const test = resultOf(daemonRun.report, t.file, t.title);
  if (test?.status === "passed" || test?.status === "failed") return undefined;
  if (test === undefined || test.status === UNFINISHED) {
    return daemonRun.unreported.get(t.file) ?? "its run has no result for it";
  }
  return `it was ${test.status}`;
}

/**
 * The file a stack's line is at: `at name (path:line:col)`, `at path:line:col`, either maybe
 * `async`, the path maybe a file URL, kept as written. Undefined for a line that isn't a frame or has no place, as
 * `at async Promise.all (index 0)`.
 */
export function framePath(line: string): string | undefined {
  const frame = /^\s*at (.+?)\s*$/.exec(line)?.[1];
  if (frame === undefined) return undefined;
  const where = /\(([^()]*)\)$/.exec(frame)?.[1] ?? frame.replace(/^async /, "");
  return /^(.+):\d+:\d+$/.exec(where)?.[1];
}

/**
 * Whether a failure message failed in the test file itself: the first frame of its stack outside
 * node and node_modules is `file`'s, as an `expect` in the test's body is. A throw from a helper,
 * as a daemon that never started or a wait that gave up, isn't.
 */
export function failedInTest(message: string, file: string): boolean {
  const own = message
    .split("\n")
    .map(framePath)
    .find(
      (path) => path !== undefined && !path.startsWith("node:") && !path.includes("/node_modules/"),
    );
  return own !== undefined && (own === file || own.endsWith(`/${file}`));
}

/** A listed test's run on the Rust daemon: its verdict, and why, when that is no verdict. */
export interface RustRun {
  outcome: Outcome;
  failure: string | undefined;
  why?: string;
}

/**
 * A listed test's verdict from its run on the Rust daemon. A base that is the Rust daemon half
 * ported fails a test for many reasons that aren't the change, so, as a Rust test's mutant must,
 * the run kills a test only on an assertion in it, and only with every binary it may run the
 * base's: `unbuilt` are those the base doesn't build.
 */
export function onRustDaemon(
  report: VitestReport,
  t: TestRef,
  unbuilt: readonly string[],
): RustRun {
  const outcome = classify(report, t.file, t.title);
  const failure = outcome === "SURVIVED" ? undefined : failureLine(report, t.file, t.title);
  if (outcome === "SURVIVED") return { outcome, failure };
  if (outcome === "INVALID") return { outcome, failure, why: "timed out on the Rust daemon" };
  if (unbuilt.length > 0) {
    const none = unbuilt.map((b) => `target/${b}`).join(", ");
    return {
      outcome: "INVALID",
      failure,
      why: `failed on the Rust daemon; the base builds no ${none}`,
    };
  }
  const messages = resultOf(report, t.file, t.title)?.failureMessages ?? [];
  if (!messages.some((m) => failedInTest(m, t.file))) {
    return {
      outcome: "INVALID",
      failure,
      why: "failed on the Rust daemon, but not on an assertion in the test",
    };
  }
  return { outcome, failure };
}

/**
 * A listed test's verdict from its run on each daemon, both judged with the base's code. It is
 * KILLED when either failed it, and SURVIVED when either is related to the change and passed it:
 * the change it accompanies may land in either daemon. `onTypeScript` is judged as an unlisted
 * test is; the Rust run is made only for a test related to what it reverted.
 */
export function onBothDaemons(onTypeScript: Judged, onRust: RustRun): Judged {
  const t = { file: onTypeScript.file, title: onTypeScript.title };
  if (onTypeScript.outcome === "KILLED") return onTypeScript;
  if (onRust.outcome === "KILLED") {
    return { ...t, outcome: "KILLED", failure: onRust.failure, note: " (on the Rust daemon)" };
  }
  if (onRust.outcome === "SURVIVED") {
    const on = onTypeScript.outcome === "SURVIVED" ? "both daemons" : "the Rust daemon";
    return { ...t, outcome: "SURVIVED", note: ` (passed on ${on})` };
  }
  if (onTypeScript.outcome === "SURVIVED") return onTypeScript;
  return {
    ...t,
    outcome: "INVALID",
    failure: onRust.failure,
    note: ` (${onRust.why ?? "no verdict on the Rust daemon"})`,
  };
}

const PRINTED_LINE_MAX = 300;

/**
 * The lines of what a test or a command said, safe to print: terminal escapes dropped, and each
 * other control character a space, since one left in, a lone \r above all, could overwrite the
 * line in a terminal.
 */
const printableLines = (text: string): string[] =>
  stripVTControlCharacters(text)
    .split("\n")
    .map((line) => line.replace(/\p{Cc}/gu, " "));

/** The line cut short between graphemes, so a character is never cut in two. */
function clipped(line: string): string {
  const chars = Array.from(new Intl.Segmenter().segment(line), (s) => s.segment);
  return chars.length > PRINTED_LINE_MAX
    ? `${chars.slice(0, PRINTED_LINE_MAX - 1).join("")}…`
    : line;
}

/**
 * The first line of what failed the test: its first failure message's, or, where it has none, its
 * file's, as a file that fails to load has. Undefined when neither says anything.
 */
export function failureLine(report: VitestReport, file: string, title: string): string | undefined {
  const messages = [
    resultOf(report, file, title)?.failureMessages[0],
    report.testResults.find((r) => r.name.endsWith(file))?.message,
  ];
  for (const message of messages) {
    const line = printableLines(message ?? "")
      .map((l) => l.trim())
      .find((l) => l !== "");
    if (line !== undefined) return clipped(line);
  }
  return undefined;
}

// Runtime imports: `import … from`/`export … from` (not `import type`), `import "…"` and
// `import("…")`. A type-only import can't change what a test does at run time.
const STATIC_IMPORT = /\b(?:import|export)\s+(type\s+)?[^;'"]*?\bfrom\s*["']([^"']+)["']/g;
const BARE_IMPORT = /\bimport\s*\(?\s*["']([^"']+)["']/g;
// A script a test runs as a child process rather than importing it.
const FILE_URL = /\bnew\s+URL\(\s*["']([^"':]+)["']\s*,\s*import\.meta\.url\s*\)/g;
const WORKSPACE = /^(@bazhen\/[^/]+)/;

const runtimeSpecifiers = (source: string): string[] =>
  [
    ...[...source.matchAll(STATIC_IMPORT)].filter((m) => !m[1]).map((m) => m[2]),
    ...[...source.matchAll(BARE_IMPORT)].map((m) => m[1]),
  ].filter((s): s is string => s !== undefined);

/** The paths a relative specifier in the file `from` may name. */
function namedPaths(from: string, specifier: string): string[] {
  const path = posix.join(posix.dirname(from), specifier);
  return /\.[cm]?[jt]sx?$/.test(path)
    ? [path]
    : [path, `${path}.ts`, `${path}.tsx`, `${path}/index.ts`];
}

/**
 * falsify's own files: this script and everything it imports at run time, followed through its
 * relative imports, with each workspace package it imports as that package's folder. `read`
 * returns a file's text, or undefined when there is no such file.
 */
export function harnessFiles(
  read: (path: string) => string | undefined,
  packages: Record<string, string>,
): string[] {
  const files = new Set<string>();
  const folders = new Set<string>();
  const queue = [HARNESS];
  for (let path = queue.shift(); path !== undefined; path = queue.shift()) {
    const source = files.has(path) ? undefined : read(path);
    if (source === undefined) continue;
    files.add(path);
    for (const specifier of runtimeSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const found = namedPaths(path, specifier).find((c) => read(c) !== undefined);
        if (found !== undefined) queue.push(found);
      } else {
        const dir = packages[WORKSPACE.exec(specifier)?.[1] ?? ""];
        if (dir !== undefined) folders.add(`${dir}/`);
      }
    }
  }
  return [...files, ...folders].toSorted();
}

const HARNESS = "scripts/falsify.ts";

/** The reverted paths among `ranFrom`, what the binaries a test runs were built from. */
export const builtFromReverts = (revertedPaths: string[], ranFrom: readonly string[]): string[] =>
  revertedPaths.filter((r) => ranFrom.includes(r));

/**
 * The reverted paths a test file imports directly: a relative specifier resolved against the
 * test's folder (with `.ts`, `.tsx` or `/index.ts` tried when it has no extension), or a
 * workspace package (`@bazhen/x`, `@bazhen/x/sub`), which counts every reverted path under that
 * package's folder. A `new URL("<path>", import.meta.url)` naming a reverted file counts too, so
 * a test that runs a script instead of importing it is related to it, and so does any of
 * `ranFrom`, what the binaries the test names were built from. `packages` maps package
 * names to folders, e.g. `@bazhen/core` → `packages/core`.
 */
export function relatedReverts(
  testPath: string,
  testSource: string,
  revertedPaths: string[],
  packages: Record<string, string>,
  ranFrom: readonly string[] = [],
): string[] {
  const related = new Set<string>(builtFromReverts(revertedPaths, ranFrom));
  for (const [, url = ""] of testSource.matchAll(FILE_URL)) {
    const path = posix.join(posix.dirname(testPath), url);
    if (revertedPaths.includes(path)) related.add(path);
  }
  for (const specifier of runtimeSpecifiers(testSource)) {
    if (specifier.startsWith(".")) {
      const named = namedPaths(testPath, specifier);
      for (const r of revertedPaths) if (named.includes(r)) related.add(r);
    } else {
      const dir = packages[WORKSPACE.exec(specifier)?.[1] ?? ""];
      if (dir === undefined) continue;
      for (const r of revertedPaths) if (r.startsWith(`${dir}/`)) related.add(r);
    }
  }
  return [...related];
}

/**
 * The binaries in the repository's target/ the file at `path` names, as `<profile>/<name>`: a
 * string `target/<profile>/<name>`, or a `new URL` resolving there. An absolute path, as a
 * fixture's `/repo/target/release/bazhen-hook`, isn't the repository's.
 */
export function namedBinaries(path: string, source: string): string[] {
  const named = new Set<string>();
  for (const [, string = ""] of source.matchAll(TARGET_STRING)) {
    named.add(string.slice("target/".length));
  }
  for (const [, url = ""] of source.matchAll(FILE_URL)) {
    const binary = IN_TARGET.exec(posix.join(posix.dirname(path), url))?.[1];
    if (binary !== undefined) named.add(binary);
  }
  return [...named];
}

/**
 * The names a crate's manifest gives, its package's and its binaries': what a binary in target/
 * may be called. A path into target/ with any other name, as a fixture's, names no binary.
 */
export const manifestNames = (manifest: string): string[] =>
  [...manifest.matchAll(/^name\s*=\s*"([^"]+)"/gm)].map(([, name = ""]) => name);

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asTable = (value: unknown) => (isTable(value) ? value : undefined);

/**
 * The binaries the crates among `files` build, as cargo infers them: each `[[bin]]` the manifest
 * names, and, unless `[package] autobins = false`, the package's own for a src/main.rs and one
 * for each src/bin/<name>.rs or src/bin/<name>/main.rs, less those a `[[bin]]` takes by its name
 * or its path. A manifest that doesn't parse builds none: cargo would build nothing from it.
 * `read` returns a file's text.
 */
export function crateBinaries(
  files: ReadonlySet<string>,
  read: (path: string) => string | undefined,
): Set<string> {
  const names = new Set<string>();
  for (const manifestPath of files) {
    const dir = /^(crates\/[^/]+)\/Cargo\.toml$/.exec(manifestPath)?.[1];
    if (dir === undefined) continue;
    let manifest: Record<string, unknown>;
    try {
      manifest = parseToml(read(manifestPath) ?? "");
    } catch {
      continue;
    }
    const pkg = asTable(manifest["package"]);
    const own = typeof pkg?.["name"] === "string" ? pkg["name"] : undefined;
    const has = (path: string) => files.has(`${dir}/${path}`);
    const bins = Array.isArray(manifest["bin"]) ? (manifest["bin"] as unknown[]) : [];
    const explicit = bins.flatMap((bin) => {
      const name = asTable(bin)?.["name"];
      if (typeof name !== "string") return [];
      const path = asTable(bin)?.["path"];
      const at =
        typeof path === "string"
          ? posix.normalize(path)
          : [
              `src/bin/${name}.rs`,
              `src/bin/${name}/main.rs`,
              ...(name === own ? ["src/main.rs"] : []),
            ].find(has);
      return [{ name, path: at }];
    });
    const binDir = `${dir}/src/bin/`;
    const inferred =
      pkg?.["autobins"] === false
        ? []
        : [
            ...(own !== undefined && has("src/main.rs")
              ? [{ name: own, path: "src/main.rs" }]
              : []),
            ...[...files].flatMap((file) => {
              if (!file.startsWith(binDir)) return [];
              const [, single, folder] =
                /^([^/]+)\.rs$|^([^/]+)\/main\.rs$/.exec(file.slice(binDir.length)) ?? [];
              const name = single ?? folder;
              return name === undefined ? [] : [{ name, path: file.slice(dir.length + 1) }];
            }),
          ];
    for (const { name } of explicit) names.add(name);
    for (const { name, path } of inferred) {
      if (!explicit.some((e) => e.name === name || e.path === path)) names.add(name);
    }
  }
  return names;
}

/**
 * The file each workspace package specifier names, from each package's `exports` map, as
 * `@bazhen/protocol/id` → `packages/protocol/src/id.ts`. `manifests` are the packages' folders
 * and their package.json text.
 */
export function workspaceExports(
  manifests: readonly { dir: string; text: string }[],
): Record<string, string> {
  const files: Record<string, string> = {};
  for (const { dir, text } of manifests) {
    const parsed: unknown = JSON.parse(text);
    if (typeof parsed !== "object" || parsed === null) continue;
    const name = "name" in parsed ? parsed.name : undefined;
    const exports = "exports" in parsed ? parsed.exports : undefined;
    if (typeof name !== "string" || typeof exports !== "object" || exports === null) continue;
    for (const [subpath, file] of Object.entries(exports)) {
      if (typeof file !== "string") continue;
      files[`${name}${subpath.slice(1)}`] = posix.join(dir, file);
    }
  }
  return files;
}

/**
 * The binaries the test at `testPath` names `direct`ly, itself or in a file it imports, and every
 * one it `reaches`: named by anything its imports, or the source files named by their path from
 * the repository's root (`apps/daemon/src/main.ts`, which a test spawns), lead to, followed to
 * their end. An import is relative, or a workspace package's, as `exports` maps it to a file.
 * `read` returns a file's text, or undefined where there is none.
 */
export function binariesOf(
  testPath: string,
  read: (path: string) => string | undefined,
  exports: Readonly<Record<string, string>> = {},
): { direct: string[]; reached: string[] } {
  const direct = new Set<string>();
  const reached = new Set<string>();
  const seen = new Set([testPath]);
  // Each file with whether its binaries are the test's own: the test's, or one it imports's.
  const queue: [string, boolean][] = [[testPath, true]];
  const visit = (path: string | undefined, own: boolean) => {
    if (path === undefined || seen.has(path)) return;
    seen.add(path);
    queue.push([path, own]);
  };
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    const [path, own] = next;
    const source = read(path);
    if (source === undefined) continue;
    for (const binary of namedBinaries(path, source)) {
      reached.add(binary);
      if (own) direct.add(binary);
    }
    for (const specifier of runtimeSpecifiers(source)) {
      const imported = specifier.startsWith(".")
        ? namedPaths(path, specifier).find((c) => read(c) !== undefined)
        : exports[specifier];
      visit(imported, own && path === testPath);
    }
    for (const [, named = ""] of source.matchAll(ROOT_SOURCE)) visit(named, false);
  }
  return { direct: [...direct], reached: [...reached] };
}

/**
 * The files under `root` a cargo dep-info file (`<binary>.d`) lists as its binary's inputs,
 * relative to `root`. Its first rule names them, separated by spaces, a space in a path escaped.
 */
export function depInfoSources(text: string, root: string): string[] {
  const rule = text.split("\n", 1)[0] ?? "";
  const prefix = `${root}/`;
  return (rule.match(/(?:\\.|\S)+/g) ?? [])
    .slice(1)
    .map((path) => path.replaceAll(/\\(.)/g, "$1"))
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length));
}

/**
 * What a binary built from `sources` was built from: those files and the manifest of each crate
 * they sit in, which cargo's dep-info doesn't list. The workspace's manifest and lockfile aren't
 * counted: they pin every crate's dependencies, so a change to them alone can't be told from one
 * for another crate, and a CLI test that passes on it needs a control rather than failing.
 */
export function binaryInputs(sources: string[]): string[] {
  const crates = new Set(sources.flatMap((s) => /^crates\/[^/]+\//.exec(s) ?? []));
  return [...sources, ...[...crates].map((c) => `${c}Cargo.toml`)];
}

/** The lines of a cargo build's stderr that state an error, as `error[E0425]: …`. */
export const cargoErrors = (said: string): string[] =>
  said.split("\n").filter((line) => /^error(?:\[\w+\])?:/.test(line));

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

export function removeWorktree(dir: string, top: string): void {
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
let running: { child: ChildProcess; graceMs: number } | undefined;
let cleanup: (() => void) | undefined;
let signalled = false;

const exitCodeFor = (signal: unknown) =>
  signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : signal === "SIGHUP" ? 129 : undefined;

/** SIGTERM to the child's group, then SIGKILL after a grace period. */
async function stopGroup(child: ChildProcess, graceMs: number): Promise<void> {
  signalGroup(child, "SIGTERM");
  await new Promise<void>((done) => {
    const timer = setTimeout(done, graceMs);
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
    if (running) await stopGroup(running.child, running.graceMs);
  } finally {
    // A timeout may be stopping the same group, and signalGroup throws once it has gone.
    cleanup?.();
    process.exit(exitCodeFor(signal) ?? 1);
  }
}

const handleSignal = (signal: NodeJS.Signals) => void onSignal(signal);

/** How a child ended: `ok` only when it exited 0 within its time. */
export type Ran = {
  ok: boolean;
  timedOut: boolean;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: string;
};

function run(
  cmd: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  options: {
    env?: NodeJS.ProcessEnv;
    stdout?: number;
    stderr?: number;
    killGraceMs?: number;
  } = {},
): Promise<Ran> {
  return new Promise((done) => {
    const child = spawnGroup(cmd, args, {
      cwd,
      env: options.env ?? isolatedEnv(),
      stdio: ["ignore", options.stdout ?? "ignore", options.stderr ?? "ignore"],
    });
    const graceMs = options.killGraceMs ?? KILL_GRACE_MS;
    running = { child, graceMs };
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // A signal may be stopping the same group, and signalGroup throws once it has gone; a
      // refused target is a fault, and surfaces.
      stopGroup(child, graceMs).catch(rethrowUnsafe);
    }, timeoutMs);
    const finish = (ended: Omit<Ran, "ok" | "timedOut">) => {
      clearTimeout(timer);
      // After a signal, onSignal owns the exit: main must not go on to the next step.
      if (signalled) return;
      running = undefined;
      done({ ...ended, ok: ended.code === 0 && !timedOut, timedOut });
    };
    child.once("error", (error) => finish({ code: null, signal: null, error: error.message }));
    child.once("exit", (code, signal) => finish({ code, signal }));
  });
}

/**
 * Runs a command in `dir` with its stdout and stderr in `dir/<log>`, and returns how it ended and
 * what it printed.
 */
async function logged(
  cmd: string,
  args: string[],
  dir: string,
  log: string,
  timeoutMs: number,
  env?: NodeJS.ProcessEnv,
): Promise<Ran & { said: string }> {
  const path = join(dir, log);
  const fd = openSync(path, "w");
  let ran: Ran;
  try {
    ran = await run(cmd, args, dir, timeoutMs, { stdout: fd, stderr: fd, ...(env && { env }) });
  } finally {
    closeSync(fd);
  }
  return { ...ran, said: readFileSync(path, "utf8") };
}

/** Offline first: in the test container, the store the image fetched is all there is. */
export const INSTALL_MODES = ["--offline", "--prefer-offline"] as const;

// --ignore-scripts: the root `prepare` script (husky) would set core.hooksPath in the shared git
// config. The dependencies' builds still have to run, as the checkout's install ran them, or a
// test fails on the base for want of one: Claude Code's links the native binary the api tests
// start, and without it `claude` is a stub that exits 1. `pnpm rebuild` runs those allowBuilds
// approves and no project's own lifecycle script; `--pending` would run the root's `prepare`.
export const installArgs = (mode: (typeof INSTALL_MODES)[number]) => [
  "install",
  "--frozen-lockfile",
  "--ignore-scripts",
  mode,
];

/** Runs `pnpm <args>` in `dir`, and returns the end of what it said if it failed. */
async function pnpmFailure(dir: string, args: string[], log: string): Promise<string | undefined> {
  const { ok, said } = await logged("pnpm", args, dir, log, INSTALL_TIMEOUT_MS);
  return ok ? undefined : indentedTail(said);
}

/**
 * Why the worktree's dependencies couldn't be installed and built, with the end of what pnpm said,
 * or undefined once they are.
 */
async function install(dir: string): Promise<string | undefined> {
  const said: string[] = [];
  for (const mode of INSTALL_MODES) {
    const failed = await pnpmFailure(dir, installArgs(mode), `falsify-install${mode.slice(1)}.log`);
    if (failed === undefined) {
      const unbuilt = await pnpmFailure(dir, ["rebuild"], "falsify-rebuild.log");
      if (unbuilt === undefined) return undefined;
      return (
        "falsify: `pnpm rebuild` couldn't run the dependencies' builds in the temporary worktree. " +
        "A dependency with a build script has to be named in pnpm-workspace.yaml's allowBuilds, " +
        `true to run it or false to leave it unbuilt.\n\`pnpm rebuild\` said:\n${unbuilt}`
      );
    }
    said.push(`\`pnpm install ${mode}\` said:\n${failed}`);
  }
  return (
    "falsify: couldn't install dependencies in the temporary worktree; run `pnpm install` and " +
    `retry.\n${said.join("\n")}`
  );
}

const TAIL_LINES = 20;

/**
 * The last lines of a command's output, printable and indented, or a note that it printed nothing.
 */
export function indentedTail(text: string): string {
  const lines = printableLines(text)
    .map((line) => line.trimEnd())
    .filter((line) => line !== "");
  if (lines.length === 0) return "  (nothing)";
  return lines
    .slice(-TAIL_LINES)
    .map((line) => `  ${clipped(line)}`)
    .join("\n");
}

/**
 * A detached worktree of `commit` in `dir`, locked in the same step as it is created, so a crash
 * can never leave an unlocked (and so never-swept) worktree behind.
 */
export function addWorktree(dir: string, commit: string, top: string): void {
  git(["worktree", "add", "--quiet", "--detach", "--lock", "--reason", LOCK, dir, commit], top);
}

const LOCK = `bz-falsify pid=${process.pid}`;

const cargoTarget = (top: string) => join(top, "target", "falsify");

const rustEnv = (top: string): NodeJS.ProcessEnv => ({
  ...gateEnv(isolatedEnv()),
  CARGO_TARGET_DIR: cargoTarget(top),
});

/**
 * Whether cargo, run in the temporary worktree `dir` to do `what`, would read a config falsify
 * refuses; it says which.
 */
function refusesCargoConfig(dir: string, what: string): boolean {
  const cargoHome = process.env["CARGO_HOME"] ?? join(homedir(), ".cargo");
  const unsafeConfig = configFailures(outsideConfigs(dir, cargoHome), (path) =>
    existsSync(path) ? readFileSync(path, "utf8") : undefined,
  );
  if (unsafeConfig.length === 0) return false;
  console.error(
    `falsify: cargo would read this config while it ${what} in a temporary worktree under ` +
      `${tmpdir()}:\n${unsafeConfig.join("\n")}`,
  );
  return true;
}

/** Each binary a build made, as `<profile>/<name>`, and the files it was built from. */
type Built = Map<string, string[]>;

/** Calls `each` with every dep-info file at the top of the profile folders under `target`. */
function eachDepInfo(target: string, each: (folder: string, name: string) => void): void {
  for (const profile of Object.keys(PROFILES)) {
    const folder = join(target, profile);
    if (!existsSync(folder)) continue;
    for (const name of readdirSync(folder)) if (name.endsWith(".d")) each(folder, name);
  }
}

/**
 * Each binary `cargo metadata` lists in the workspace, mapped to its package. Throws on anything
 * that isn't such a listing, so one that went wrong is never read as a workspace without binaries.
 */
export function workspaceBins(metadata: unknown): Map<string, string> {
  const packages =
    typeof metadata === "object" && metadata !== null && "packages" in metadata
      ? metadata.packages
      : undefined;
  if (!Array.isArray(packages)) throw new Error("not a cargo metadata listing: no packages");
  const bins = new Map<string, string>();
  for (const pkg of packages as unknown[]) {
    const name = typeof pkg === "object" && pkg !== null && "name" in pkg ? pkg.name : undefined;
    const targets =
      typeof pkg === "object" && pkg !== null && "targets" in pkg ? pkg.targets : undefined;
    if (typeof name !== "string" || !Array.isArray(targets)) {
      throw new Error("not a cargo metadata listing: a package without a name or targets");
    }
    for (const t of targets as unknown[]) {
      if (typeof t !== "object" || t === null || !("name" in t) || !("kind" in t)) continue;
      if (typeof t.name === "string" && Array.isArray(t.kind) && t.kind.includes("bin")) {
        bins.set(t.name, name);
      }
    }
  }
  return bins;
}

/**
 * Builds `wanted` (`<profile>/<name>`) in the worktree `dir`, those the base's workspace has, with
 * `cargo build`, copies each one to the worktree's own target/, and returns them with what each
 * was built from; or undefined, with the reason printed, so no test is judged against a binary
 * that isn't the base's.
 */
async function buildBinaries(
  dir: string,
  top: string,
  wanted: readonly string[],
): Promise<Built | undefined> {
  if (refusesCargoConfig(dir, "builds the base's binaries")) return undefined;
  const listed = await capture(
    "cargo",
    ["metadata", "--no-deps", "--format-version", "1", "--offline"],
    dir,
    "falsify-metadata.json",
    { env: rustEnv(top), timeoutMs: CARGO_TIMEOUT_MS },
  );
  let bins: Map<string, string>;
  try {
    if (!listed.ok) throw new Error("it failed");
    bins = workspaceBins(JSON.parse(listed.out));
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    console.error(
      `falsify: \`cargo metadata\` couldn't list the base's binaries (${why}), so the tests that ` +
        "run one can't be judged.",
    );
    return undefined;
  }
  const target = cargoTarget(top);
  // Cargo writes a binary's dep-info on every build, a no-op one included, so the ones that come
  // back mark what this run built; one left by an earlier run would name another worktree's files.
  eachDepInfo(target, (folder, name) => rmSync(join(folder, name), { force: true }));
  const requested: string[] = [];
  for (const [folder, profile] of Object.entries(PROFILES)) {
    // A binary the base doesn't have isn't built; a test that runs it gets no verdict.
    const names = wanted.flatMap((w) => {
      const name = w.slice(folder.length + 1);
      return w.startsWith(`${folder}/`) && bins.has(name) ? [name] : [];
    });
    if (names.length === 0) continue;
    requested.push(...names.map((name) => `${folder}/${name}`));
    const packages = [...new Set(names.map((name) => bins.get(name) ?? ""))];
    const args = [
      "build",
      "--quiet",
      "--locked",
      "--profile",
      profile,
      ...packages.flatMap((p) => ["-p", p]),
      ...names.flatMap((name) => ["--bin", name]),
    ];
    const log = join(dir, `falsify-build-${profile}.log`);
    const fd = openSync(log, "w");
    let ran: Ran;
    try {
      ran = await run("cargo", args, dir, CARGO_TIMEOUT_MS, { env: rustEnv(top), stderr: fd });
    } finally {
      closeSync(fd);
    }
    if (!ran.ok) {
      const said = readFileSync(log, "utf8");
      const errors = cargoErrors(said);
      const why = ran.timedOut
        ? `it timed out after ${CARGO_TIMEOUT_MS / 1000} s`
        : errors.length > 0
          ? `cargo said:\n${errors.map((line) => `  ${line}`).join("\n")}`
          : "it named no cargo error";
      console.error(
        `falsify: \`cargo ${args.join(" ")}\` failed in the temporary worktree, so the tests that ` +
          `run a binary can't be judged against the base's: ${why}\nThe end of what it said:\n` +
          indentedTail(said),
      );
      return undefined;
    }
  }
  const root = realpathSync(dir);
  const built: Built = new Map();
  let unknown: string | undefined;
  eachDepInfo(target, (folder, name) => {
    const binary = join(folder, name.slice(0, -".d".length));
    if (!existsSync(binary)) return;
    const sources = depInfoSources(readFileSync(join(folder, name), "utf8"), root);
    // None when a cargo config sets build.dep-info-basedir, which makes the paths relative.
    if (!sources.some((s) => s.startsWith("crates/"))) unknown ??= join(folder, name);
    const named = `${basename(folder)}/${basename(binary)}`;
    const copy = join(dir, "target", named);
    mkdirSync(dirname(copy), { recursive: true });
    copyFileSync(binary, copy);
    chmodSync(copy, statSync(binary).mode);
    built.set(named, binaryInputs(sources));
  });
  if (unknown !== undefined) {
    console.error(
      `falsify: cargo's record of what a base binary was built from, ${unknown}, names no file ` +
        `under ${root}/crates, so the reverts it covers are unknown and no test can be judged.`,
    );
    return undefined;
  }
  const unrecorded = requested.filter((binary) => !built.has(binary));
  if (unrecorded.length > 0) {
    console.error(
      `falsify: the base's binaries built, but cargo wrote no dep-info under ${target} for ` +
        `${unrecorded.join(", ")}, so what they were built from is unknown and no test that runs ` +
        "one can be judged.",
    );
    return undefined;
  }
  return built;
}

/**
 * Runs a command in `dir` with its stdout in `dir/<file>`, and returns whether it exited 0 and
 * what it printed.
 */
async function capture(
  cmd: string,
  args: string[],
  dir: string,
  file: string,
  options: { env: NodeJS.ProcessEnv; timeoutMs: number; killGraceMs?: number; errFile?: string },
): Promise<{ ok: boolean; out: string; err: string; timedOut: boolean }> {
  const path = join(dir, file);
  const errPath = options.errFile === undefined ? undefined : join(dir, options.errFile);
  const fd = openSync(path, "w");
  const errFd = errPath === undefined ? undefined : openSync(errPath, "w");
  let ran: Ran;
  try {
    ran = await run(cmd, args, dir, options.timeoutMs, {
      env: options.env,
      stdout: fd,
      ...(errFd === undefined ? {} : { stderr: errFd }),
      ...(options.killGraceMs === undefined ? {} : { killGraceMs: options.killGraceMs }),
    });
  } finally {
    closeSync(fd);
    if (errFd !== undefined) closeSync(errFd);
  }
  const err = errPath === undefined ? "" : readFileSync(errPath, "utf8");
  return { ok: ran.ok, out: readFileSync(path, "utf8"), err, timedOut: ran.timedOut };
}

const LEFT_RUNNING = /^capped: stopped (\d+) process\(es\) its command left running(?:: (.+))?$/m;

/**
 * What capped's report on a run says its command left running, as "N process(es)" or the names
 * it counted, or undefined when it says nothing was.
 */
export function leftRunning(report: string): string | undefined {
  const match = LEFT_RUNNING.exec(report);
  if (match === null) return undefined;
  return match[2] ?? `${match[1]} process(es)`;
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

const MUTANTS_HINT = `if cargo-mutants is missing, install it: ${installCommand("cargo-mutants")}`;

/** The mutants cargo-mutants lists in `dir` in the code the diff in the file `diff` touches. */
async function listMutants(dir: string, top: string, diff: string): Promise<unknown> {
  const { ok, out } = await capture(
    "cargo-mutants",
    ["mutants", "--list", "--json", "--no-config", "--workspace", "--diff", "--in-diff", diff],
    dir,
    "falsify-mutants.json",
    { env: rustEnv(top), timeoutMs: CARGO_TIMEOUT_MS },
  );
  if (!ok) throw new Error("cargo-mutants failed");
  return mutantListing(out);
}

// Each test's own timeout, so a mutant that loops ends that test, not the whole run.
const NEXTEST_PROFILE = `[profile.falsify]
slow-timeout = { period = "5s", terminate-after = 2 }
fail-fast = false
`;

/**
 * Runs `tests` once in `dir` and returns nextest's libtest-json-plus output, however it exited,
 * whether it ran out of time, and what it left running.
 */
async function runRustTests(dir: string, top: string, tests: RustTest[]): Promise<NextestRun> {
  const kills = join(dir, "falsify-memory-kills");
  rmSync(kills, { force: true });
  const env: NodeJS.ProcessEnv = {
    ...rustEnv(top),
    NEXTEST_EXPERIMENTAL_LIBTEST_JSON: "1",
    [KILLS_ENV]: kills,
  };
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
    // A test that signals processes is ignored outside a sandbox; inside one it is judged. The
    // filter names only the branch's new tests, but every one of them runs, whatever it is
    // ignored for.
    ...(inSandbox() ? ["--run-ignored", "all"] : []),
    "-E",
    nextestFilter(tests),
  ];
  // A test ended at its time limit, by a mutant or not, dies before its Drop stops what it
  // started, and a holder it started is in a session of its own, out of every process group's
  // reach: only stopping a scope the run had to itself ends it, before the next run. Capped's
  // report on that scope says what it stopped, for the caller to judge. The time cap only backs up
  // falsify's own timeout. Each test process's runner names the test in `kills` when a memory cap
  // killed it.
  const backstopS = Math.min(Math.ceil(MUTANT_TIMEOUT_MS / 1000) + 60, MAX_BACKSTOP_S);
  const caps = ["--memory", MUTANT_RUN_MEMORY, "--time", `${backstopS}s`];
  const contained = [CAPPED, OWN_SCOPE_FLAG, ...caps, "--", "cargo-nextest", ...args];
  const { out, err, timedOut } =
    process.env[UNCONTAINED_ENV] === "1"
      ? await capture("cargo-nextest", args, dir, "falsify-results.json", {
          env,
          timeoutMs: MUTANT_TIMEOUT_MS,
        })
      : await capture(process.execPath, contained, dir, "falsify-results.json", {
          env,
          timeoutMs: MUTANT_TIMEOUT_MS,
          killGraceMs: CAPPED_STOP_GRACE_MS,
          errFile: "falsify-capped.log",
        });
  const left = leftRunning(err);
  return {
    out,
    timedOut,
    memoryKilled: existsSync(kills),
    ...(left === undefined ? {} : { left }),
  };
}

type NextestRun = { out: string; timedOut: boolean; memoryKilled: boolean; left?: string };

export type RustVerdict = RustTest & { outcome: Outcome; note: string };
type RustJudgement = {
  verdicts: RustVerdict[];
  unapplied: string[];
  timedOut: string[];
  memoryKilled: string[];
  /** Each run without a mutant that left processes running, with no test ended to explain it. */
  leaked: string[];
  ran: number;
  total: number;
};

const TIME_LIMIT = "time limit exceeded";

const key = (t: RustTest) => `${t.file} ${t.title}`;

/** Which tests a run's results show passing: an `ok`, and nothing else for the same test. */
function passing(events: TestEvent[]): (t: RustTest) => boolean {
  const ok = new Set(events.filter((e) => e.event === "ok").map((e) => e.test));
  const not = new Set(
    events.filter((e) => e.event !== "ok" && e.event !== "started").map((e) => e.test),
  );
  return (t) => ok.has(key(t)) && !not.has(key(t));
}

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
    return {
      verdicts,
      unapplied: [],
      timedOut: [],
      memoryKilled: [],
      leaked: [],
      ran: 0,
      total: 0,
    };
  }
  const diffFile = join(dir, "falsify-rust.diff");
  writeFileSync(diffFile, diff);
  let mutants: Mutant[];
  try {
    mutants = parseMutants(await listMutants(dir, top, diffFile));
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
  // Read before any mutant is applied: where a failure points is judged against the source as
  // the branch has it.
  const sources = new Map(
    git(["ls-files", "--", "crates/*.rs"], dir)
      .split("\n")
      .filter(Boolean)
      .map((file) => [file, readFileSync(join(dir, file), "utf8")]),
  );
  const isTestCode = inTestCode(sources);

  // A crate's library and binaries share a target, so a new test named as one the base already
  // has there would be credited with the old test's failures.
  const counts = new Map<string, number>();
  for (const t of added) counts.set(key(t), (counts.get(key(t)) ?? 0) + 1);
  const shared = (t: RustTest) => (counts.get(key(t)) ?? 0) > 1;
  const runnable = added.filter((t) => filterable(t) && !atBase.has(key(t)) && !shared(t));
  const unmutatedStart = performance.now();
  const unmutated =
    runnable.length > 0 && mutants.length > 0
      ? await runRustTests(dir, top, runnable)
      : { out: "", timedOut: false, memoryKilled: false };
  const leaked: string[] = [];
  // A run without a mutant that leaves processes running shows a test's own leak, which fails
  // falsify, as it would any run around it; unless a test of it was ended at a time limit, since
  // that test died before it could stop what it started, and it is judged invalid already.
  const judgeLeftovers = (tried: NextestRun, tests: RustTest[], which: string) => {
    if (tried.left === undefined) return;
    const ended =
      tried.timedOut || testEvents(tried.out, targets).some((e) => e.reason === TIME_LIMIT);
    const what = `the ${which} run of ${tests.map(key).join(", ")} left ${tried.left} running`;
    if (!ended) leaked.push(what);
    else
      console.error(`falsify: ${what}, stopped with it, after a test was ended at its time limit`);
  };
  judgeLeftovers(unmutated, runnable, "unmutated");
  const passedUnmutated = passing(testEvents(unmutated.out, targets));
  let pending = runnable.filter(passedUnmutated);
  if (runnable.length > 0 && mutants.length > 0) {
    console.error(
      `falsify: ${counted(runnable.length, "new Rust test")} run unmutated in ` +
        `${secondsSince(unmutatedStart)} s, ${pending.length} passing`,
    );
  }
  const killedBy = new Map<string, string>();
  const unapplied: string[] = [];
  const timedOut: string[] = [];
  const memoryKilled: string[] = [];
  let ran = 0;
  for (const mutant of mutants) {
    if (pending.length === 0 || ran === MAX_MUTANTS) break;
    const isTest = isTestCode(unmutate(mutant.patch, mutant.file));
    let ranOutOfTime = false;
    let ranOutOfMemory = false;
    const failedUnder = async (tests: RustTest[]) => {
      const tried = await runRustTests(dir, top, tests);
      ranOutOfTime ||= tried.timedOut;
      ranOutOfMemory ||= tried.memoryKilled;
      const failed = new Set(
        testEvents(tried.out, targets)
          .filter((r) => failedOnAssertion(r, isTest))
          .map((r) => r.test),
      );
      return tests.filter((t) => failed.has(key(t)));
    };
    let confirmed: RustTest[] = [];
    const against = pending.length;
    const start = performance.now();
    const applied = await withMutant(dir, mutant, async () => {
      ran += 1;
      const candidates = await failedUnder(pending);
      // Run once more, so a test that fails now and then isn't credited to whichever mutant it
      // happened to fail under.
      confirmed = candidates.length > 0 ? await failedUnder(candidates) : [];
    });
    if (!applied) unapplied.push(mutant.name);
    if (ranOutOfTime) timedOut.push(mutant.name);
    if (ranOutOfMemory) memoryKilled.push(mutant.name);
    if (confirmed.length > 0) {
      // And once with the mutant undone: a test that fails without it too, from state an earlier
      // run left behind, failed for some other reason than the mutant.
      const recheck = await runRustTests(dir, top, confirmed);
      judgeLeftovers(recheck, confirmed, "recheck");
      const passesAgain = passing(testEvents(recheck.out, targets));
      for (const t of confirmed.filter(passesAgain)) killedBy.set(key(t), mutant.name);
      pending = pending.filter((t) => !killedBy.has(key(t)));
    }
    if (applied) {
      const stopped = [ranOutOfTime && " (timed out)", ranOutOfMemory && " (memory-killed)"];
      console.error(
        `falsify: mutant ${ran} of at most ${MAX_MUTANTS} (${mutants.length} listed), against ` +
          `${counted(against, "test")}, killed ${against - pending.length} in ` +
          `${secondsSince(start)} s${stopped.filter(Boolean).join("")}: ${mutant.name}`,
      );
    }
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
    if (unmutated.timedOut && !passedUnmutated(t)) {
      return invalidRust(t, `the unmutated run timed out after ${MUTANT_TIMEOUT_MS / 1000} s`);
    }
    if (unmutated.memoryKilled && !passedUnmutated(t)) {
      return invalidRust(t, "a test process was killed at the memory cap unmutated");
    }
    if (!passedUnmutated(t)) return invalidRust(t, "fails or doesn't run unmutated");
    return invalidRust(
      t,
      capped
        ? `no mutant failed it on an assertion within the first ${MAX_MUTANTS}`
        : "no mutant of the change failed it on an assertion",
    );
  });
  return { verdicts, unapplied, timedOut, memoryKilled, leaked, ran, total: mutants.length };
}

/**
 * The Rust tests HEAD has and the base hasn't, listed by nextest in a temporary worktree, each
 * judged by mutating the code the branch changed; or undefined, with the reason printed, when
 * they couldn't be listed or judged. Listing sees every test however it is declared: by
 * `#[test]`, proptest, or a macro of the crate's own. Mutants are applied only in that worktree,
 * which is removed on every way out, a signal included.
 */
async function judgeRustTests(top: string, base: string, head: string, rustFiles: string[]) {
  const dir = mkdtempSync(join(tmpdir(), WORKTREE_PREFIX));
  cleanup = () => {
    cleanup = undefined;
    removeWorktree(dir, top);
  };
  try {
    if (refusesCargoConfig(dir, "runs the Rust tests")) return undefined;
    addWorktree(dir, base, top);
    const before = await listRustTests(dir, top);
    git(["checkout", "--quiet", "--detach", head], dir);
    const after = await listRustTests(dir, top);
    if (before === undefined || after === undefined) {
      const where = before === undefined ? `the base, ${base.slice(0, 12)}` : "HEAD";
      console.error(
        `falsify: \`cargo-nextest nextest list\` failed at ${where}, so the Rust tests the ` +
          "branch adds are unknown. Run `moon run :test-rust` there to see why; if cargo-nextest is " +
          `missing, install it: ${installCommand("cargo-nextest")}`,
      );
      return undefined;
    }
    const atBase = rustTestIds(before);
    const added = addedRustTests(atBase, rustTestIds(after));
    if (added.length === 0)
      return {
        verdicts: [],
        unapplied: [],
        timedOut: [],
        memoryKilled: [],
        leaked: [],
        ran: 0,
        total: 0,
      };
    // Mutants are made only in the changed files, and the new tests live in them.
    if (!judgeableHere(signallingWork(rustFiles, rustFiles, [base, head], fileAt))) {
      return undefined;
    }
    return await mutateRustTests(dir, top, [base, head], after, added, new Set(atBase));
  } finally {
    cleanup?.();
  }
}

const USAGE = "usage: node scripts/falsify.ts [--base <ref> | --harness]";

/**
 * The `--base` ref from the arguments, or `--harness`, which lists falsify's own files instead of
 * judging; throws on anything else.
 */
export function parseArgs(args: string[]): { base?: string; harness?: true } {
  if (args.length === 0) return {};
  if (args.length === 1 && args[0] === "--harness") return { harness: true };
  const [flag, value, ...rest] = args;
  if (flag !== "--base" || value === undefined || value.startsWith("-") || rest.length > 0) {
    throw new Error(USAGE);
  }
  return { base: value };
}

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
export function mergeBase(ref?: string): string {
  const target = ref ?? (resolves("origin/main") ? "origin/main" : "main");
  return git(["merge-base", target, "HEAD"]).trim();
}

const GUARD_INDEX_PREFIX = "bz-falsify-guard-";

/** `git` with input on stdin, in `cwd`, with `env`. */
const gitWith = (args: string[], cwd: string, env: NodeJS.ProcessEnv, input?: string) =>
  execFileSync("git", args, {
    cwd,
    env,
    input: input ?? "",
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });

/**
 * `git` on a scratch index of falsify's own. `isolatedEnv()` strips GIT_INDEX_FILE, so without
 * this a `read-tree` would replace the developer's index and an `apply --cached` stage a break
 * there. Refuses any index that isn't in a folder falsify made under the temp dir, or is the
 * checkout's own.
 */
function scratchIndexGit(index: string, args: string[], input?: string): string {
  const folder = dirname(index);
  const own = resolve(git(["rev-parse", "--git-path", "index"]).trim());
  if (
    !isAbsolute(index) ||
    !basename(folder).startsWith(GUARD_INDEX_PREFIX) ||
    dirname(realpathSync(folder)) !== realpathSync(tmpdir()) ||
    resolve(index) === own ||
    (existsSync(dirname(own)) && realpathSync(dirname(own)) === realpathSync(folder))
  ) {
    throw new Error(`falsify: refusing to use ${index} as a scratch index`);
  }
  return gitWith(args, process.cwd(), { ...isolatedEnv(), GIT_INDEX_FILE: index }, input);
}

/**
 * `git` in falsify's temporary worktree, and nowhere else: before every call, the worktree's top
 * level must be `dir`, a folder falsify made under the temp dir. A reset or apply that reached the
 * developer's checkout would destroy their uncommitted work.
 */
function worktreeGit(dir: string, args: string[], input?: string): string {
  const top = realpathSync(git(["rev-parse", "--show-toplevel"], dir).trim());
  if (
    top !== realpathSync(dir) ||
    !basename(top).startsWith(WORKTREE_PREFIX) ||
    dirname(top) !== realpathSync(tmpdir())
  ) {
    throw new Error(
      `falsify: refusing to run git ${args[0] ?? ""} outside its worktree, in ${top}`,
    );
  }
  return gitWith(args, dir, isolatedEnv(), input);
}

/**
 * The files a break modifies, as `git apply` reads it without applying it, or why it may not be
 * a break: it doesn't read as a patch, or it does more than modify text.
 */
function breakPaths(patch: string): string[] | string {
  const apply = (flags: string[]) =>
    gitWith(["apply", "--recount", ...flags, "-"], process.cwd(), isolatedEnv(), patch);
  let paths: string[] | undefined;
  let summary: string;
  try {
    paths = numstatPaths(apply(["--numstat", "-z"]));
    summary = apply(["--summary"]);
  } catch (error) {
    if (signalExitCode(error) !== undefined) throw error;
    return "doesn't read as a patch";
  }
  if (paths === undefined || reshapes(summary)) {
    return (
      "must only modify text: it may not create, delete, rename or copy a file, change a " +
      "mode, or be binary"
    );
  }
  return paths;
}

/**
 * Whether `after` holds code `before` doesn't: other tokens, comments and layout aside, or, for a
 * file that isn't TypeScript the scanner can read, other text once whitespace is gone. A break
 * that changes neither leaves the code it claims to break as it was.
 */
export function changesCode(before: string, after: string): boolean {
  const [was, now] = [codeTokens(before), codeTokens(after)];
  if (typeof was === "string" || typeof now === "string") {
    return before.replaceAll(/\s+/g, "") !== after.replaceAll(/\s+/g, "");
  }
  return was.length !== now.length || was.some((token, i) => token !== now[i]);
}

/** A guard's break, the tests it names, and why it can't run for each test it can't. */
export type GuardPlan = {
  commit: string;
  patch: string;
  tests: TestRef[];
  paths: string[];
  refusals: Map<string, string>;
};

/**
 * The guards that name new tests, each checked before anything runs: its break must modify text
 * only, of files each test is related to and not its support, apply to HEAD, and not be of a
 * `.fails` test. `strays` are the subjects that name no new test; `signalling` the files a break
 * leaves signalling.
 */
function checkedGuards(
  guards: Guard[],
  targets: TestRef[],
  head: string,
  related: (t: TestRef) => string[],
  atHead: (path: string) => string | undefined,
): { plans: GuardPlan[]; strays: string[]; signalling: string[] } {
  const strays: string[] = [];
  const signalling: string[] = [];
  const plans: GuardPlan[] = [];
  for (const guard of guards) {
    const tests: TestRef[] = [];
    for (const subject of guard.subjects) {
      const test = namedBy(subject, targets);
      if (test === undefined) strays.push(`Guard: ${subject}`);
      else if (!tests.includes(test)) tests.push(test);
    }
    if (tests.length === 0) continue;
    const short = guard.commit.slice(0, 12);
    // The first reason a test's guard can't run is the one it is told.
    const refusals = new Map<string, string>();
    const refuse = (t: TestRef, why: string) => {
      if (!refusals.has(keyOf(t))) refusals.set(keyOf(t), why);
    };
    const refuseAll = (why: string) => {
      for (const t of tests) refuse(t, why);
    };
    let paths: string[] = [];
    if (guard.patch === "") {
      refuseAll(`commit ${short} holds no \`\`\`diff block`);
    } else {
      const read = breakPaths(guard.patch);
      if (typeof read === "string") {
        refuseAll(`the break in ${short} ${read}`);
      } else {
        paths = read;
        for (const t of tests) {
          const why = paths
            .map((path) => brokenPathRefusal(path, related(t)))
            .find((w) => w !== undefined);
          if (why !== undefined) refuse(t, `the break in ${short}: ${why}`);
          else if (isFailsTest(atHead(t.file) ?? "", t.title)) {
            refuse(t, "it is written with .fails, which inverts its result");
          }
        }
        const folder = mkdtempSync(join(tmpdir(), GUARD_INDEX_PREFIX));
        try {
          const index = join(folder, "index");
          scratchIndexGit(index, ["read-tree", head]);
          let applied = true;
          try {
            scratchIndexGit(index, ["apply", "--cached", "--recount", "-"], guard.patch);
          } catch (error) {
            if (signalExitCode(error) !== undefined) throw error;
            applied = false;
            refuseAll(
              `the break in ${short} doesn't apply to HEAD. If git's message cleanup collapsed ` +
                "its blank lines, commit it with --cleanup=verbatim",
            );
          }
          if (applied) {
            let changed = false;
            for (const path of paths) {
              const broken = scratchIndexGit(index, ["show", `:${path}`]);
              if (isSignallingSource(path, broken)) signalling.push(path);
              if (changesCode(atHead(path) ?? "", broken)) changed = true;
            }
            if (!changed)
              refuseAll(`the break in ${short} changes no code, only comments or layout`);
          }
        } finally {
          rmSync(folder, { recursive: true, force: true });
        }
      }
    }
    plans.push({ commit: guard.commit, patch: guard.patch, tests, paths, refusals });
  }
  return { plans, strays, signalling };
}

async function main(args: string[]): Promise<number> {
  let options: { base?: string; harness?: true };
  try {
    options = parseArgs(args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : USAGE);
    return 2;
  }
  const top = git(["rev-parse", "--show-toplevel"]).trim();
  workFromRoot(top);
  if (options.harness) {
    const read = (path: string) => {
      const file = join(top, path);
      return existsSync(file) && statSync(file).isFile() ? readFileSync(file, "utf8") : undefined;
    };
    console.log(harnessFiles(read, workspacePackages(top)).join("\n"));
    return 0;
  }
  // A test of falsify run in falsify's own worktree may start falsify again. Against a throwaway
  // repository that is the test; against the repository being judged it would judge it again,
  // in a worktree of its own, without end.
  const repository = realpathSync(
    git(["rev-parse", "--path-format=absolute", "--git-common-dir"]).trim(),
  );
  if (process.env[JUDGING] === repository) {
    console.error(
      "falsify: a falsify run is already judging this repository, and something it ran started " +
        "falsify on it again. A test must start falsify only on a repository of its own.",
    );
    return 2;
  }
  process.env[JUDGING] = repository;
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

  const changes = parseNameStatus(git(["diff", "--name-status", "-z", "-M", ...range]));
  const tests = changes.filter((c) => c.status !== "D" && TEST_FILE.test(c.path));
  const { atHead: headPath, atBase: basePath } = counterparts(changes);
  const texts = new Map<string, string | undefined>();
  const textAt = (rev: string, path: string) => {
    const at = `${rev}:${path}`;
    if (!texts.has(at)) texts.set(at, fileAt(rev, path));
    return texts.get(at);
  };
  const ends = {
    old: (file: string): FileSides => {
      const at = headPath(file);
      return { file, base: textAt(base, file), head: textAt(head, at), counterpart: at };
    },
    new: (file: string): FileSides => {
      const at = basePath(file);
      return { file, base: textAt(base, at), head: textAt(head, file), counterpart: at };
    },
  };
  const found = tests.flatMap((t) => {
    const { titles, unreadable } = changedTests(ends.new(t.path));
    if (unreadable !== undefined) {
      console.log(
        `falsify: ${t.path}: ${unreadable}, so its new tests count as one whose title couldn't be read`,
      );
    }
    return titles.map((title) => ({ file: t.path, title }));
  });
  const olds = new Map(leavableTestFiles(changes).map((path) => [path, ends.old(path)]));
  const targets = leaveOutRenames(found, renameTrailers(messages), olds, ends.new);
  const renameOf = (t: TestRef) => {
    const from = renamedFrom({ ...ends.new(t.file), title: t.title }, [...olds.values()]);
    return from === undefined ? undefined : renamedLine({ from, to: t });
  };
  const headFiles = new Set(
    git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", head]).split("\0"),
  );
  const blobs = new Map<string, string>();
  const atHead = (path: string) => {
    if (!headFiles.has(path)) return undefined;
    const text = blobs.get(path) ?? git(["cat-file", "blob", `${head}:${path}`]);
    blobs.set(path, text);
    return text;
  };
  const crateNames = new Set(
    [...headFiles]
      .filter((path) => /^crates\/[^/]+\/Cargo\.toml$/.test(path))
      .flatMap((path) => manifestNames(atHead(path) ?? "")),
  );
  const isBinary = (binary: string) => crateNames.has(binary.slice(binary.indexOf("/") + 1));
  // A binary the branch adds may be one the Rust daemon starts, from beside itself: the base
  // builds none, so a failure on the Rust daemon may be only its absence.
  const baseFiles = new Set(
    git(["ls-tree", "-r", "-z", "--name-only", "--full-tree", base]).split("\0"),
  );
  const atBase = (path: string) =>
    baseFiles.has(path) ? git(["cat-file", "blob", `${base}:${path}`]) : undefined;
  const baseBinaries = crateBinaries(baseFiles, atBase);
  const addedBinaries = [...crateBinaries(headFiles, atHead)]
    .filter((name) => !baseBinaries.has(name))
    .map((name) => `release/${name}`);
  const exports = workspaceExports(
    [...headFiles]
      .filter((path) => /^(?:apps|packages)\/[^/]+\/package\.json$/.test(path))
      .map((path) => ({ dir: posix.dirname(path), text: atHead(path) ?? "{}" })),
  );
  const binaries = new Map(
    targets.map((t) => {
      const { direct, reached } = binariesOf(t.file, atHead, exports);
      return [t.file, { direct: direct.filter(isBinary), reached: reached.filter(isBinary) }];
    }),
  );
  // A test in a file the Rust daemon's list names holds both daemons, so it runs on each.
  const onList = new Set(listedFiles(atHead(LIST) ?? ""));
  const listedTargets = targets.filter((t) => onList.has(t.file));
  // Only the binaries a judged test may run are built: a release build links each with LTO.
  const wanted = [
    ...new Set([
      ...[...binaries.values()].flatMap((b) => b.reached),
      ...(listedTargets.length > 0 ? [RUST_DAEMON] : []),
    ]),
  ].filter((binary) => PROFILES[binary.slice(0, binary.indexOf("/"))] !== undefined);
  const runsBinaries = wanted.length > 0;
  // Before any test runs, Rust's included: the TS side would refuse after the mutants had run.
  const reverts = revertsOf(changes, { rust: runsBinaries });
  const guards = checkedGuards(
    guardsOf(git(["log", "--format=%H%x00%B%x00", `${base}..${head}`])),
    targets,
    head,
    (t) =>
      relatedReverts(
        t.file,
        atHead(t.file) ?? "",
        reverts.flatMap(pathsOf),
        workspacePackages(top),
      ),
    atHead,
  );
  const breaks = guards.plans.filter((g) => g.patch !== "").length;
  if (breaks > MAX_GUARD_BREAKS) {
    console.error(
      `falsify: ${breaks} commits carry a guard's break, and falsify runs at most ` +
        `${MAX_GUARD_BREAKS}. Give guards that break the same code one commit.`,
    );
    return 1;
  }
  if (targets.length > 0 && reverts.length > 0) {
    const work = signallingWork(
      [...reverts.flatMap(pathsOf), ...guards.plans.flatMap((g) => g.paths)],
      targets.map((t) => t.file),
      [base, head],
      fileAt,
    );
    const sources = [...new Set([...work.sources, ...guards.signalling])];
    if (!judgeableHere({ ...work, sources })) return 1;
  }
  let rust: RustJudgement = {
    verdicts: [],
    unapplied: [],
    timedOut: [],
    memoryKilled: [],
    leaked: [],
    ran: 0,
    total: 0,
  };
  if (changes.some((c) => RUST_INPUT.test(c.path) || RUST_INPUT.test(c.oldPath ?? ""))) {
    process.on("SIGINT", handleSignal);
    process.on("SIGTERM", handleSignal);
    process.on("SIGHUP", handleSignal);
    try {
      const rustFiles = changes.flatMap(pathsOf).filter((path) => path.endsWith(".rs"));
      const judged = await judgeRustTests(top, base, head, rustFiles);
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
    if (guards.strays.length === 0) return 0;
    console.error(
      `\nThese Guard: lines name no new TypeScript test:\n${guards.strays.map((l) => `  ${l}`).join("\n")}`,
    );
    return 1;
  }

  const results: Judged[] = [];

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
      // `git rm` also removes the folders it empties: cargo takes an empty folder left under
      // crates/ for a workspace member without a manifest, and refuses to build.
      const remove = (path: string) => git(["rm", "--quiet", "--force", "--", path], dir);
      for (const c of reverts) {
        if (c.status === "A" || c.status === "C") remove(c.path);
        else if (c.status === "R" && c.oldPath) {
          remove(c.path);
          git(["checkout", base, "--", c.oldPath], dir);
        } else git(["checkout", base, "--", c.path], dir);
      }
      const notInstalled = await install(dir);
      if (notInstalled !== undefined) {
        console.error(notInstalled);
        return 1;
      }
      let built: Built = new Map();
      if (runsBinaries) {
        const made = await buildBinaries(dir, top, wanted);
        if (made === undefined) return 1;
        built = made;
      }
      if (listedTargets.length > 0 && !built.has(RUST_DAEMON)) {
        console.error(
          `falsify: the base builds no ${DAEMON}, so the new tests in files ${LIST} names can't ` +
            `be judged on the Rust daemon, and none is judged:\n` +
            listedTargets.map((t) => `  ${t.file} › ${t.title}`).join("\n"),
        );
        return 1;
      }
      // A CLI test runs the binary BAZHEN_CLI names: the base's, never the caller's own build.
      const vitestEnv = runsBinaries
        ? { ...isolatedEnv(), BAZHEN_CLI: join(dir, "target", "release", "bazhen") }
        : undefined;
      // Each vitest step's output goes to a log beside its report, at the worktree's root: both
      // are untracked there, nothing judged reads them, and they go with the worktree.
      const listFile = join(dir, "falsify-projects.json");
      const listed = await logged(
        "pnpm",
        [
          "exec",
          "vitest",
          "list",
          "--filesOnly",
          `--json=${listFile}`,
          ...new Set(targets.map((t) => t.file)),
        ],
        dir,
        "falsify-vitest-list.log",
        VITEST_TIMEOUT_MS,
        vitestEnv,
      );
      const listing = readWritten(listFile);
      let projects: Map<string, string[]> | undefined;
      let why: string | undefined;
      if (listing.kind === "json") {
        try {
          projects = projectsOf(listing.value, [dir, realpathSync(dir)]);
        } catch (error) {
          why = error instanceof Error ? error.message : String(error);
        }
      }
      if (projects === undefined) {
        // Listing only globs the config's include patterns, so a failure is a fault, not a verdict.
        const reason =
          (listed.ok ? why : undefined) ??
          noOutputReason(listed, listing, "listing", VITEST_TIMEOUT_MS);
        console.error(
          `falsify: \`vitest list\` couldn't name the projects of the tests to judge (${reason}), so ` +
            `none can be judged. The end of what it printed:\n${indentedTail(listed.said)}`,
        );
        return 1;
      }
      // One run per project, as its own moon task runs it: two projects' global setups in one
      // process clash (one sets the home the other refuses, or puts a refusing tmux on PATH).
      const runProjects = async (
        runs: [string, string[]][],
        env: NodeJS.ProcessEnv,
        { tag, on }: { tag: string; on: string },
      ) => {
        const report: VitestReport = { testResults: [] };
        // What the reporter recorded of each run that left no report, read after every report so a
        // file another project's run judged in full keeps that run's verdict.
        const stopped: VitestReport["testResults"] = [];
        const unreported = new Map<string, string>();
        for (const [index, [project, inProject]] of runs.entries()) {
          const reportFile = join(dir, `falsify-report-${tag}${index}.json`);
          const resultsFile = join(dir, `falsify-results-${tag}${index}.jsonl`);
          const files = counted(inProject.length, "file");
          console.error(`falsify: running the ${project} project${on} (${files})`);
          const start = performance.now();
          const ran = await logged(
            "pnpm",
            [
              "exec",
              "vitest",
              "run",
              "--project",
              project,
              ...inProject,
              `--reporter=${REPORTER}`,
              "--reporter=json",
              `--outputFile=${reportFile}`,
            ],
            dir,
            `falsify-vitest-${tag}${index}.log`,
            VITEST_TIMEOUT_MS,
            { ...env, [RESULTS_FILE_ENV]: resultsFile },
          );
          console.error(`falsify: the ${project} run${on} took ${secondsSince(start)} s`);
          const written = readWritten(reportFile);
          if (written.kind === "json" && isReport(written.value)) {
            report.testResults.push(...written.value.testResults);
            continue;
          }
          // The run's tests that finished are judged from what the reporter recorded; each of its
          // targets that didn't is INVALID: say why once, and name it on each.
          const recorded = partialReport(readRecorded(resultsFile)).testResults;
          stopped.push(...recorded);
          const collected = recorded.flatMap((suite) => suite.assertionResults);
          const finished = collected.filter((t) => t.status !== UNFINISHED).length;
          const reason = noOutputReason(ran, written, "report", VITEST_TIMEOUT_MS);
          const judged =
            collected.length === 0
              ? ""
              : ` ${finished} of the ${collected.length} tests it collected finished, and are judged ` +
                "from what falsify's reporter recorded as each ended.";
          console.error(
            `falsify: the ${project} run${on} (${files}) left no report: ${reason}.${judged} The end of ` +
              `what it printed:\n${indentedTail(ran.said)}`,
          );
          for (const file of inProject) {
            unreported.set(file, `the ${project} run${on}: ${reason}`);
          }
        }
        report.testResults.push(...stopped);
        return { report, unreported };
      };
      const { report, unreported } = await runProjects([...projects], vitestEnv ?? isolatedEnv(), {
        tag: "",
        on: "",
      });
      // A listed test runs on the base's Rust daemon too, when the branch reverted something it or
      // the binaries it runs were built from: otherwise that daemon is HEAD's, and the run would
      // only repeat HEAD.
      const revertedPaths = reverts.flatMap(pathsOf);
      const builtFrom = (t: TestRef) => [
        ...(built.get(RUST_DAEMON) ?? []),
        ...(binaries.get(t.file)?.direct ?? []).flatMap((b) => built.get(b) ?? []),
      ];
      // Cargo's dep-info lists sources, not the manifests and lockfile that choose dependencies
      // and features, so a change to one is taken to change every binary.
      const manifestReverted = revertedPaths.some((p) => CARGO_MANIFEST.test(p));
      const onDaemon = listedTargets.filter(
        (t) => manifestReverted || builtFromReverts(revertedPaths, builtFrom(t)).length > 0,
      );
      const daemonFiles = new Set(onDaemon.map((t) => t.file));
      const daemonRuns = [...projects].flatMap(([project, files]): [string, string[]][] => {
        const inProject = files.filter((file) => daemonFiles.has(file));
        return inProject.length > 0 ? [[project, inProject]] : [];
      });
      const onRust =
        daemonRuns.length === 0
          ? undefined
          : await runProjects(
              daemonRuns,
              { ...(vitestEnv ?? isolatedEnv()), [SELECTOR]: join(dir, "target", RUST_DAEMON) },
              { tag: "rust-", on: " on the Rust daemon" },
            );
      // A listed test with no pass or fail on the Rust daemon would leave its verdict to the
      // TypeScript daemon alone, which can't see a change to the Rust one.
      const unrun = onDaemon.flatMap((t) => {
        const reason = onRust === undefined ? "it wasn't run" : unrunReason(onRust, t);
        return reason === undefined
          ? []
          : [`  ${t.file} › ${t.title} didn't run to an end on the Rust daemon (${reason})`];
      });
      if (unrun.length > 0) {
        console.error(
          `falsify: these new tests in files ${LIST} names have no result on the Rust daemon, so ` +
            `none is judged:\n${unrun.join("\n")}`,
        );
        return 1;
      }
      // A passing test that imports none of the reverted files is a test of code the branch didn't
      // change (a characterization or property test): no verdict, so it needs a control.
      const packages = workspacePackages(dir);
      const onTypeScript = (t: TestRef): Judged => {
        const outcome = classify(report, t.file, t.title);
        const failure = outcome === "SURVIVED" ? undefined : failureLine(report, t.file, t.title);
        const source = readFileSync(join(dir, t.file), "utf8");
        const { direct = [], reached = [] } = binaries.get(t.file) ?? {};
        const inputs = direct.flatMap((b) => built.get(b) ?? []);
        const unbuilt = reached.filter((b) => !built.has(b));
        if (
          outcome === "SURVIVED" &&
          relatedReverts(t.file, source, revertedPaths, packages, inputs).length === 0
        ) {
          return { ...t, outcome: "INVALID", unrelated: true };
        }
        if (outcome === "KILLED" && unbuilt.length > 0) {
          return { ...t, outcome: "INVALID", unbuilt, failure };
        }
        // Keyed by file: a file in two projects may have its verdict from the other's report.
        const noReport =
          outcome === "INVALID" && !finishedIn(report, t.file, t.title)
            ? unreported.get(t.file)
            : undefined;
        return { ...t, outcome, failure, noReport };
      };
      for (const t of targets) {
        const judged = onTypeScript(t);
        results.push(
          onRust === undefined || !onDaemon.includes(t)
            ? judged
            : onBothDaemons(
                judged,
                onRustDaemon(onRust.report, t, [
                  ...(binaries.get(t.file)?.reached ?? []).filter((b) => !built.has(b)),
                  ...addedBinaries,
                ]),
              ),
        );
      }
      // A surviving test a guard names: HEAD must pass it, and each break that names it must fail
      // it on an assertion of its own. Each break runs alone, on HEAD reset in between.
      const guardsOn = (t: TestRef) =>
        guards.plans.filter((g) => g.tests.some((n) => keyOf(n) === keyOf(t)));
      const candidates: Judged[] = [];
      for (const r of results) {
        if (r.outcome !== "SURVIVED" || guardsOn(r).length === 0) continue;
        const refused = guardsOn(r)
          .map((g) => g.refusals.get(keyOf(r)))
          .find((reason) => reason !== undefined);
        if (refused !== undefined) r.guard = refused;
        else if ((binaries.get(r.file)?.reached.length ?? 0) > 0 || onList.has(r.file)) {
          r.guard = "it runs a Rust binary or both daemons, which a guard's run can't build";
        } else candidates.push(r);
      }
      if (candidates.length > 0) {
        const inProjects = (files: Set<string>) =>
          [...projects].flatMap(([project, inProject]): [string, string[]][] => {
            const these = inProject.filter((file) => files.has(file));
            return these.length > 0 ? [[project, these]] : [];
          });
        const guardEnv = vitestEnv ?? isolatedEnv();
        worktreeGit(dir, ["reset", "--quiet", "--hard", head]);
        const control = await runProjects(
          inProjects(new Set(candidates.map((t) => t.file))),
          guardEnv,
          { tag: "guard-head-", on: " at HEAD, for its guards" },
        );
        const passingAtHead = candidates.filter((t) => {
          if (resultOf(control.report, t.file, t.title)?.status === "passed") return true;
          t.guard = "it doesn't pass at HEAD without a break, so a break failing it shows nothing";
          return false;
        });
        const under = new Map<string, { commit: string; failure: string | undefined }[]>();
        for (const [index, g] of guards.plans.entries()) {
          const guarded = passingAtHead.filter((t) => g.tests.some((n) => keyOf(n) === keyOf(t)));
          if (guarded.length === 0) continue;
          const short = g.commit.slice(0, 12);
          try {
            worktreeGit(dir, ["apply", "--recount", "-"], g.patch);
          } catch (error) {
            if (signalExitCode(error) !== undefined) throw error;
            for (const t of guarded)
              t.guard ??= `the break in ${short} doesn't apply in the worktree`;
            continue;
          }
          try {
            const { report: broken } = await runProjects(
              inProjects(new Set(guarded.map((t) => t.file))),
              guardEnv,
              { tag: `guard-${index}-`, on: ` under the break in ${short}` },
            );
            for (const t of guarded) {
              const outcome = classify(broken, t.file, t.title);
              const failures = resultOf(broken, t.file, t.title)?.failureMessages ?? [];
              if (outcome === "KILLED" && failedOnOwnAssertion(failures, t.file)) {
                under.set(keyOf(t), [
                  ...(under.get(keyOf(t)) ?? []),
                  { commit: short, failure: failureLine(broken, t.file, t.title) },
                ]);
              } else {
                t.guard ??=
                  outcome === "SURVIVED"
                    ? `it passes under the break in ${short}`
                    : outcome === "KILLED"
                      ? `it fails under the break in ${short}, but not on an assertion of its own`
                      : `it has no pass or fail under the break in ${short} (a timeout, or no result)`;
              }
            }
          } finally {
            worktreeGit(dir, ["reset", "--quiet", "--hard", head]);
          }
        }
        for (const t of passingAtHead) {
          const failedUnder = under.get(keyOf(t));
          if (t.guard === undefined && failedUnder !== undefined) {
            t.outcome = "GUARDED";
            t.guardedBy = failedUnder;
          }
        }
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
    const note =
      r.note ??
      (r.noReport !== undefined
        ? ` (no report from ${r.noReport})`
        : r.unrelated
          ? " (passed; unrelated to the source change)"
          : r.unbuilt
            ? ` (failed; the base builds no ${r.unbuilt.map((b) => `target/${b}`).join(", ")})`
            : "");
    const guard = r.guard === undefined ? "" : ` (its guard doesn't hold: ${r.guard})`;
    console.log(`  ${r.outcome.padEnd(8)} ${r.file} › ${r.title}${note}${guard}`);
    if (r.failure !== undefined) console.log(`           failed: ${r.failure}`);
    for (const { commit, failure } of r.guardedBy ?? []) {
      console.log(`           under the break in ${commit}: ${failure ?? "(no message)"}`);
    }
  }
  const unguarded = guardErrors(guards, results);
  if (unguarded.length > 0) {
    console.error(
      "\nA guard is for a new test that passes without the change. These Guard: lines name " +
        `none:\n${unguarded.map((line) => `  ${line}`).join("\n")}`,
    );
  }
  if (rust.total > 0) {
    console.log(
      `falsify: ${rust.ran} of the change's ${rust.total} Rust mutants run (at most ${MAX_MUTANTS})`,
    );
  }
  for (const name of rust.timedOut) {
    console.log(
      `  INVALID  mutant ${name} (its run timed out after ${MUTANT_TIMEOUT_MS / 1000} s)`,
    );
  }
  for (const name of rust.memoryKilled) {
    console.log(`  INVALID  mutant ${name} (a test process was killed at the memory cap)`);
  }
  for (const name of rust.unapplied) {
    console.log(`  INVALID  mutant ${name} (its patch left the file unchanged; not run)`);
  }

  if (rust.leaked.length > 0) {
    console.error(
      "\nThese runs of the new Rust tests, with no mutant applied and no test ended at a time " +
        "limit, left processes running. A test must stop what it starts, even when it passes:\n" +
        rust.leaked.map((line) => `  ${line}`).join("\n"),
    );
    return 1;
  }
  const survived = results.filter((r) => r.outcome === "SURVIVED");
  if (survived.length > 0) {
    console.error(
      "\nThese tests pass without the change, so they cannot detect it. Make each one assert the " +
        "behaviour the change introduces (bz-write-unit-test). To keep one that guards behaviour " +
        "the base already has, add a commit whose message holds a ```diff block breaking the code " +
        `it guards, and the line \`${GUARD_FORM}\`: falsify applies the break, and the test must ` +
        "fail under it on an assertion of its own.",
    );
    const renames = survived.flatMap((r) => renameOf(r) ?? []);
    if (renames.length > 0) {
      console.error(`${MOVED_OR_RENAMED}\n${renames.map((line) => `  ${line}`).join("\n")}`);
    }
    return 1;
  }
  const uncontrolledRust = uncontrolledRustTests(
    rustTests.filter((t) => t.outcome !== "KILLED").map((t) => t.title),
    messages,
  );
  if (uncontrolledRust.length > 0) {
    console.error(
      "\nNo mutant of the change showed these Rust tests can fail, so each needs a control of its " +
        "own. Break the code by hand, confirm the test fails on its assertion, and record it in a " +
        "commit message on the branch, naming the test by its full path:\n" +
        uncontrolledRust
          .map((name) => `  Control: ${name}: <what you broke> -> <how it failed>`)
          .join("\n"),
    );
  }
  // Rust verdicts are checked above, by their full path.
  const rustVerdicts = new Set<object>(rustTests);
  const uncontrolled = uncontrolledTests(
    results.filter((r) => !rustVerdicts.has(r)),
    messages,
  );
  if (uncontrolled.length > 0) {
    console.error(
      reverts.length === 0
        ? "\nThis branch adds tests but no source change to revert."
        : "\nSome tests could not be judged by reverting (new symbols, tests unrelated to the " +
            "source change, binaries the base doesn't build, unparsed titles, load errors, " +
            "timeouts, or runs that left no report).",
    );
    const hints = uncontrolled.map((test) => ({ test, renamed: renameOf(test) }));
    const controls = hints.flatMap(({ test, renamed }) => (renamed === undefined ? [test] : []));
    const moved = hints.flatMap(({ renamed }) => renamed ?? []);
    if (controls.length > 0) {
      console.error(
        "Each needs a control of its own. Break the code by hand, confirm the test fails on its " +
          "assertion, and record it in a commit message on the branch, naming the test by its " +
          "file and title:\n" +
          controls.map((t) => `  ${controlLine(t)}`).join("\n"),
      );
    }
    if (moved.length > 0) {
      console.error(`${MOVED_OR_RENAMED}\n${moved.map((line) => `  ${line}`).join("\n")}`);
    }
  }
  return uncontrolledRust.length > 0 || uncontrolled.length > 0 || unguarded.length > 0 ? 1 : 0;
}

/**
 * The `Guard:` lines that name no new TypeScript test, or a test that didn't survive, so its
 * guard shows nothing: each as written, or with the test it names and its verdict.
 */
export function guardErrors(
  guards: { plans: { tests: TestRef[] }[]; strays: string[] },
  results: Judged[],
): string[] {
  const named = guards.plans.flatMap((g) => g.tests);
  const errors = guards.strays.map((line) => `${line} (it names no new TypeScript test)`);
  for (const t of named.filter((n, i) => named.findIndex((m) => keyOf(m) === keyOf(n)) === i)) {
    const outcome = results.find((r) => keyOf(r) === keyOf(t))?.outcome;
    if (outcome === "SURVIVED" || outcome === "GUARDED") continue;
    errors.push(`${t.file} › ${t.title} (${outcome ?? "not judged"})`);
  }
  return errors;
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

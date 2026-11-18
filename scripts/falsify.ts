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
// binary reached that the base has is built there with `pnpm run build:bins`, and each one this
// run built is copied to the worktree's target/: the test runs the base's binaries, built with
// HEAD's script, toolchain and .cargo config. Only a name a crate's manifest declares counts. A
// test is related to a reverted file that a binary it names, or a file it imports directly names,
// was built from, as cargo's dep-info for it lists, or to that binary's crates' manifests. A test
// that fails while it reaches a binary the base doesn't build is INVALID: the binary's absence
// failed it. Binaries that won't build are no verdict: falsify fails, naming cargo's error.
//
// The judged tests run once per vitest project, as each project's pnpm script runs them: two
// projects' global setups in one process clash.
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
// A test is new when its title is: HEAD's copy of the file has more tests with that title than
// the base's, read from both copies' test calls (scripts/test-calls.ts), however git's diff aligns
// them or the formatter lays them out. A test that moved, or whose body changed under its title,
// isn't new.
//
// A test renamed or moved to another test file, and otherwise unchanged, isn't new, and a commit
// trailer on the branch says so: `Renamed: <old file> › <old title> -> <new file> › <new title>`,
// the old file as the base has it and the new as HEAD has it. It is left out only when it holds:
// the old title is one test in the old file at the base and none in it at HEAD, the new title one
// in the new file at HEAD and none in it at the base, and the test's call is the base's token for
// token but for the title, comments and layout aside. Any other change, to its body, options or
// call, leaves it judged as new. A judged test that is a lost base test so moved or renamed is
// printed with the trailer it needs.
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
import { stripVTControlCharacters } from "node:util";
import { isAlive, rethrowUnsafe, signalGroup, spawnGroup } from "@bazhen/host-guard";
import { KILLS_ENV } from "./capped.ts";
import { GATES, configFailures, gateEnv, installCommand, outsideConfigs } from "./cargo-gate.ts";
import { isMain } from "./is-main.ts";
import { inSandbox, judgeableHere, signallingWork } from "./falsify-signals.ts";
import { RESULTS_FILE_ENV, UNFINISHED, partialReport } from "./falsify-reporter.ts";
import { testCalls, type TestCall } from "./test-calls.ts";
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

export type Outcome = "KILLED" | "SURVIVED" | "INVALID";
export type Change = { status: string; path: string; oldPath?: string };

const TEST_FILE = /(^|\/)[^/]+\.test\.tsx?$/;
const REVERTIBLE = /^(?:(?:apps|packages)\/[^/]+\/src\/|scripts\/.+\.tsx?$)/;
// What can change the set of Rust tests, or what a Rust binary does: a crate's files, or the
// workspace's manifest and lockfile.
const RUST_INPUT = /^(?:crates\/|Cargo\.(?:toml|lock)$)/;
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
// The test gate's build options (workspace, features, lockfile, wrapper overrides), so the tests
// listed are the ones the gate runs.
const TEST_BUILD = GATES.test.slice(
  GATES.test.indexOf("run") + 1,
  GATES.test.indexOf("--status-level"),
);
const KILL_GRACE_MS = 2000;
// Beside this file, never the worktree's copy, which the branch's revert may have changed or removed.
const REPORTER = fileURLToPath(new URL("falsify-reporter.ts", import.meta.url));
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

export function isolatedEnv(): NodeJS.ProcessEnv {
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
    outputs: [
      "packages/protocol/schema/",
      "packages/protocol/fixtures/",
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
 * and a .tsx file: its JSX could read as regexes and strings that hide a test call.
 */
export function changedTests(
  base: string | undefined,
  head: string,
  file: string,
): { titles: string[]; unreadable?: string } {
  if (file.endsWith(".tsx")) {
    return { titles: [unparsedIn(file)], unreadable: "falsify can't read JSX" };
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

/** A test file's text at the base and at HEAD, undefined where that side has no such file. */
export type FileSides = { file: string; base: string | undefined; head: string | undefined };
export type RenameEnd = FileSides & { title: string };

/**
 * Why the test `to` isn't the base's test `from`, moved to another file or given a new title,
 * or undefined when it is. `from` carries the old file at the base and the file git pairs it with
 * at HEAD; `to` the new file at HEAD and the file git pairs it with at the base. It is a rename
 * only when the old title is one test in the old file at the base and none in it at HEAD, the new
 * title one in the new file at HEAD and none in it at the base, and the test's block is the base's
 * with only its title changed.
 */
export function renameRefusal(from: RenameEnd, to: RenameEnd): string | undefined {
  const read: TestBlock[][] = [];
  for (const [text, copy] of [
    [from.base, `the base's copy of ${from.file}`],
    [from.head, `HEAD's copy of ${from.file}`],
    [to.base, `the base's copy of ${to.file}`],
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
    return `HEAD still has a test "${from.title}" in ${from.file}`;
  }
  if (titled(newBefore, to.title).length > 0) {
    return `the base already has a test "${to.title}" in ${to.file}`;
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

/** A test file's texts: `old` from its path at the base, `new` from its path at HEAD. */
type Ends = { old: (file: string) => FileSides; new: (file: string) => FileSides };

/**
 * The new tests left to judge once those a `Renamed:` trailer shows are a base test, moved or
 * under a new title, are left out, each of those printed. A trailer that applies to no test is
 * printed with why, and its test is judged.
 */
function leaveOutRenames(found: TestRef[], trailers: RenameTrailer[], ends: Ends): TestRef[] {
  const applied = new Set<string>();
  const refusals = new Map<string, string>();
  const targets = found.filter((t) => {
    for (const { trailer, readings } of trailers) {
      for (const { from } of readings.filter(
        (r) => r.to.file === t.file && r.to.title === t.title,
      )) {
        const why = renameRefusal(
          { ...ends.old(from.file), title: from.title },
          { ...ends.new(t.file), title: t.title },
        );
        if (why === undefined) {
          applied.add(trailer);
          console.log(
            `falsify: RENAMED ${t.file} › ${t.title} (was ${from.file} › ${from.title}), not judged`,
          );
          return false;
        }
        if (!refusals.has(trailer)) refusals.set(trailer, why);
      }
    }
    return true;
  });
  for (const { trailer, readings } of trailers) {
    if (applied.has(trailer)) continue;
    const why =
      readings.length === 0
        ? `it names no file: write it as ${RENAMED_FORM}`
        : (refusals.get(trailer) ?? "the branch adds no test of that name");
    console.log(`falsify: Renamed: ${trailer} doesn't apply (${why}), so its test is judged`);
  }
  return targets;
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
const keyOf = (t: { file: string; title: string }) => `${t.file}\0${t.title}`;

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
  const related = new Set<string>(revertedPaths.filter((r) => ranFrom.includes(r)));
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
  options: { env?: NodeJS.ProcessEnv; stdout?: number; stderr?: number } = {},
): Promise<Ran> {
  return new Promise((done) => {
    const child = spawnGroup(cmd, args, {
      cwd,
      env: options.env ?? isolatedEnv(),
      stdio: ["ignore", options.stdout ?? "ignore", options.stderr ?? "ignore"],
    });
    running = child;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // A signal may be stopping the same group, and signalGroup throws once it has gone; a
      // refused target is a fault, and surfaces.
      stopGroup(child).catch(rethrowUnsafe);
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
 * its own `build:bins` script, copies each one to the worktree's own target/, and returns them
 * with what each was built from; or undefined, with the reason printed, so no test is judged
 * against a binary that isn't the base's.
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
      "run",
      "build:bins",
      "--profile",
      profile,
      ...packages.flatMap((p) => ["-p", p]),
      ...names.flatMap((name) => ["--bin", name]),
    ];
    const log = join(dir, `falsify-build-${profile}.log`);
    const fd = openSync(log, "w");
    let ran: Ran;
    try {
      ran = await run("pnpm", args, dir, CARGO_TIMEOUT_MS, { env: rustEnv(top), stderr: fd });
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
        `falsify: \`pnpm ${args.join(" ")}\` failed in the temporary worktree, so the tests that ` +
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
  options: { env: NodeJS.ProcessEnv; timeoutMs: number },
): Promise<{ ok: boolean; out: string; timedOut: boolean }> {
  const path = join(dir, file);
  const fd = openSync(path, "w");
  let ran: Ran;
  try {
    ran = await run(cmd, args, dir, options.timeoutMs, { env: options.env, stdout: fd });
  } finally {
    closeSync(fd);
  }
  return { ok: ran.ok, out: readFileSync(path, "utf8"), timedOut: ran.timedOut };
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
 * and whether it ran out of time.
 */
async function runRustTests(
  dir: string,
  top: string,
  tests: RustTest[],
): Promise<{ out: string; timedOut: boolean; memoryKilled: boolean }> {
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
  // Each test process's runner names the test in `kills` when a memory cap killed it.
  const { out, timedOut } = await capture("cargo-nextest", args, dir, "falsify-results.json", {
    env,
    timeoutMs: MUTANT_TIMEOUT_MS,
  });
  return { out, timedOut, memoryKilled: existsSync(kills) };
}

export type RustVerdict = RustTest & { outcome: Outcome; note: string };
type RustJudgement = {
  verdicts: RustVerdict[];
  unapplied: string[];
  timedOut: string[];
  memoryKilled: string[];
  ran: number;
  total: number;
};

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
    return { verdicts, unapplied: [], timedOut: [], memoryKilled: [], ran: 0, total: 0 };
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
  const unmutated =
    runnable.length > 0 && mutants.length > 0
      ? await runRustTests(dir, top, runnable)
      : { out: "", timedOut: false, memoryKilled: false };
  const passedUnmutated = passing(testEvents(unmutated.out, targets));
  let pending = runnable.filter(passedUnmutated);
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
      const passesAgain = passing(testEvents(recheck.out, targets));
      for (const t of confirmed.filter(passesAgain)) killedBy.set(key(t), mutant.name);
      pending = pending.filter((t) => !killedBy.has(key(t)));
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
  return { verdicts, unapplied, timedOut, memoryKilled, ran, total: mutants.length };
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
          "branch adds are unknown. Run `pnpm test:rust` there to see why; if cargo-nextest is " +
          `missing, install it: ${installCommand("cargo-nextest")}`,
      );
      return undefined;
    }
    const atBase = rustTestIds(before);
    const added = addedRustTests(atBase, rustTestIds(after));
    if (added.length === 0)
      return { verdicts: [], unapplied: [], timedOut: [], memoryKilled: [], ran: 0, total: 0 };
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
  const ends: Ends = {
    old: (file) => ({ file, base: textAt(base, file), head: textAt(head, headPath(file)) }),
    new: (file) => ({ file, base: textAt(base, basePath(file)), head: textAt(head, file) }),
  };
  const found = tests.flatMap((t) => {
    const { base: before, head: after } = ends.new(t.path);
    const { titles, unreadable } = changedTests(before, after ?? "", t.path);
    if (unreadable !== undefined) {
      console.log(
        `falsify: ${t.path}: ${unreadable}, so its new tests count as one whose title couldn't be read`,
      );
    }
    return titles.map((title) => ({ file: t.path, title }));
  });
  const targets = leaveOutRenames(found, renameTrailers(messages), ends);
  // A test moved out of a file, or renamed in it, leaves that file changed, deleted or renamed.
  const leavable = changes
    .filter((c) => c.status !== "A" && TEST_FILE.test(c.oldPath || c.path))
    .map((c) => ends.old(c.oldPath || c.path));
  const renameOf = (t: TestRef) => {
    const from = renamedFrom({ ...ends.new(t.file), title: t.title }, leavable);
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
  // Only the binaries a judged test may run are built: a release build links each with LTO.
  const wanted = [...new Set([...binaries.values()].flatMap((b) => b.reached))].filter(
    (binary) => PROFILES[binary.slice(0, binary.indexOf("/"))] !== undefined,
  );
  const runsBinaries = wanted.length > 0;
  // Before any test runs, Rust's included: the TS side would refuse after the mutants had run.
  const reverts = revertsOf(changes, { rust: runsBinaries });
  if (targets.length > 0 && reverts.length > 0) {
    const work = signallingWork(
      reverts.flatMap(pathsOf),
      targets.map((t) => t.file),
      [base, head],
      fileAt,
    );
    if (!judgeableHere(work)) return 1;
  }
  let rust: RustJudgement = {
    verdicts: [],
    unapplied: [],
    timedOut: [],
    memoryKilled: [],
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
    return 0;
  }

  const results: {
    file: string;
    title: string;
    outcome: Outcome;
    unrelated?: boolean;
    unbuilt?: string[];
    note?: string;
    noReport?: string | undefined;
    failure?: string | undefined;
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
      // One run per project, as its own pnpm script runs it: two projects' global setups in one
      // process clash (one sets the home the other refuses, or puts a refusing tmux on PATH).
      const report: VitestReport = { testResults: [] };
      // What the reporter recorded of each run that left no report, read after every report so a
      // file another project's run judged in full keeps that run's verdict.
      const stopped: VitestReport["testResults"] = [];
      const unreported = new Map<string, string>();
      for (const [index, [project, inProject]] of [...projects].entries()) {
        const reportFile = join(dir, `falsify-report-${index}.json`);
        const resultsFile = join(dir, `falsify-results-${index}.jsonl`);
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
          `falsify-vitest-${index}.log`,
          VITEST_TIMEOUT_MS,
          { ...(vitestEnv ?? isolatedEnv()), [RESULTS_FILE_ENV]: resultsFile },
        );
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
        const files = `${inProject.length} file${inProject.length === 1 ? "" : "s"}`;
        const judged =
          collected.length === 0
            ? ""
            : ` ${finished} of the ${collected.length} tests it collected finished, and are judged ` +
              "from what falsify's reporter recorded as each ended.";
        console.error(
          `falsify: the ${project} run (${files}) left no report: ${reason}.${judged} The end of ` +
            `what it printed:\n${indentedTail(ran.said)}`,
        );
        for (const file of inProject) {
          unreported.set(file, `the ${project} run: ${reason}`);
        }
      }
      report.testResults.push(...stopped);
      // A passing test that imports none of the reverted files is a test of code the branch didn't
      // change (a characterization or property test): no verdict, so it needs a control.
      const revertedPaths = reverts.flatMap(pathsOf);
      const packages = workspacePackages(dir);
      for (const t of targets) {
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
          results.push({ ...t, outcome: "INVALID", unrelated: true });
        } else if (outcome === "KILLED" && unbuilt.length > 0) {
          results.push({ ...t, outcome: "INVALID", unbuilt, failure });
        } else {
          // Keyed by file: a file in two projects may have its verdict from the other's report.
          const noReport =
            outcome === "INVALID" && !finishedIn(report, t.file, t.title)
              ? unreported.get(t.file)
              : undefined;
          results.push({ ...t, outcome, failure, noReport });
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
    console.log(`  ${r.outcome.padEnd(8)} ${r.file} › ${r.title}${note}`);
    if (r.failure !== undefined) console.log(`           failed: ${r.failure}`);
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

  const survived = results.filter((r) => r.outcome === "SURVIVED");
  if (survived.length > 0) {
    console.error(
      "\nThese tests pass without the change, so they cannot detect it. Make each one assert the " +
        "behaviour the change introduces (bz-write-unit-test).",
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
  return uncontrolledRust.length > 0 || uncontrolled.length > 0 ? 1 : 0;
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

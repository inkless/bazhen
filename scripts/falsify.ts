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
//             adds tests without a source change also lands here. Every test of a brand-new symbol is INVALID, so it needs a hand-run control
//             recorded as a trailer in a commit on the branch:
//             `Control: <what you broke> -> <how the test failed>`.
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

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, posix } from "node:path";
import { isMain } from "./is-main.ts";

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
 */
export function newTitles(diff: string, file: string): string[] {
  const titles = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++") || !TEST_CALL.test(line)) continue;
    let parsed = false;
    for (const [, quote, title] of line.matchAll(TITLE)) {
      if (title === undefined || (quote === "`" && title.includes("${"))) continue;
      titles.add(unescape(title));
      parsed = true;
    }
    if (!parsed) titles.add(`<unparsed test in ${file}>`);
  }
  return [...titles];
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

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

/** Removes the worktrees of earlier runs that died before cleaning up. Never touches others. */
function sweepStale(top: string): void {
  const listed = git(["worktree", "list", "--porcelain"], top);
  for (const path of staleWorktrees(listed, pidAlive)) {
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

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

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
  if (running) await stopGroup(running);
  cleanup?.();
  process.exit(exitCodeFor(signal) ?? 1);
}

const handleSignal = (signal: NodeJS.Signals) => void onSignal(signal);

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: isolatedEnv(), stdio: "ignore", detached: true });
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
  if (targets.length === 0) {
    console.log(`falsify: no new tests between ${base.slice(0, 12)} and HEAD`);
    return 0;
  }

  const reverts = changes.filter(
    (c) =>
      (REVERTIBLE.test(c.path) && !TEST_FILE.test(c.path)) ||
      (c.oldPath !== undefined && REVERTIBLE.test(c.oldPath) && !TEST_FILE.test(c.oldPath)),
  );
  const results: { file: string; title: string; outcome: Outcome; unrelated?: boolean }[] = [];

  if (reverts.length === 0) {
    for (const t of targets) results.push({ ...t, outcome: "INVALID" });
  } else {
    const dir = mkdtempSync(join(tmpdir(), WORKTREE_PREFIX));
    cleanup = () => {
      cleanup = undefined;
      removeWorktree(dir, top);
    };
    // SIGHUP too: an agent's tmux pane closing mid-run must not orphan the detached children.
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    process.once("SIGHUP", handleSignal);
    try {
      // Locked in the same step as it is created, so a crash can never leave an unlocked (and so
      // never-swept) worktree behind.
      git(
        [
          "worktree",
          "add",
          "--quiet",
          "--detach",
          "--lock",
          "--reason",
          `bz-falsify pid=${process.pid}`,
          dir,
          head,
        ],
        top,
      );
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
    const note = r.unrelated ? " (passed; unrelated to the source change)" : "";
    console.log(`  ${r.outcome.padEnd(8)} ${r.file} › ${r.title}${note}`);
  }

  const survived = results.filter((r) => r.outcome === "SURVIVED");
  if (survived.length > 0) {
    console.error(
      "\nThese tests pass without the change, so they cannot detect it. Make each one assert the " +
        "behaviour the change introduces (bz-write-unit-test).",
    );
    return 1;
  }
  const invalid = results.filter((r) => r.outcome === "INVALID");
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

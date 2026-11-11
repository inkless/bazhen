// Falsification harness (docs/standards/testing.md). It answers one question about the tests a
// change adds: would they fail if the source change were not there?
//
// It runs the change's new tests against the *previous* version of the source, in a throwaway
// worktree, and classifies each new test:
//   KILLED    it failed: the test depends on the change. Good.
//   SURVIVED  it passed without the change: it cannot detect the change. Not allowed.
//   INVALID   no verdict: it couldn't load, timed out, was skipped, or its title couldn't be
//             read or isn't unique; a commit that adds tests without a source change also lands
//             here. Every test of a brand-new symbol is INVALID, so it needs a hand-run control
//             recorded as a commit trailer: `Control: <what you broke> -> <how the test failed>`.
//
// Titles come from added lines that look like `it(...)`/`test(...)` calls, so a fixture string in
// a test file such as 'it("fixture", f)' counts as a test too. It then can't be found in the
// report and comes out INVALID: the safe direction, since it asks for a control.
//
// The temporary worktree is locked with this process's pid. A run killed before it could clean
// up leaves it behind, and the next run removes it once that pid is dead.
//
// Usage:
//   node scripts/falsify.ts [<rev>]                  check an existing commit (default HEAD)
//   node scripts/falsify.ts --staged <message-file>  check the staged change (commit-msg hook)

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
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

// Git exports these to hooks (GIT_DIR in linked worktrees, GIT_INDEX_FILE always). Inherited,
// they point every command run in the temporary worktree at the real repository and index.
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

/** Git with the inherited environment: sees the real index, as the hook's caller does. */
const git = (args: string[]) =>
  execFileSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

/** Git for the temporary worktree, with the hook's repository location stripped. */
const isolatedGit = (args: string[], cwd: string) =>
  execFileSync("git", args, {
    cwd,
    env: isolatedEnv(),
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
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
  const listed = isolatedGit(["worktree", "list", "--porcelain"], top);
  for (const path of staleWorktrees(listed, pidAlive)) {
    removeWorktree(path, top);
  }
}

function removeWorktree(dir: string, top: string): void {
  const quiet = (args: string[]) => {
    try {
      isolatedGit(args, top);
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

// --ignore-scripts: the root `prepare` script would set core.hooksPath in the shared git config,
// and nothing else needs a lifecycle script (node-pty's build is declined via allowBuilds).
async function install(dir: string): Promise<boolean> {
  const flags = ["--frozen-lockfile", "--ignore-scripts"];
  return (
    (await run("pnpm", ["install", ...flags, "--offline"], dir, INSTALL_TIMEOUT_MS)) ||
    run("pnpm", ["install", ...flags, "--prefer-offline"], dir, INSTALL_TIMEOUT_MS)
  );
}

async function main(): Promise<number> {
  const staged = process.argv[2] === "--staged";
  const messageFile = staged ? process.argv[3] : undefined;
  const rev = staged ? "HEAD" : (process.argv[2] ?? "HEAD");
  const base = staged ? "HEAD" : `${rev}^`;

  if (staged && existsSync(resolve(git(["rev-parse", "--git-path", "MERGE_HEAD"]).trim()))) {
    return 0;
  }
  const top = git(["rev-parse", "--show-toplevel"]).trim();
  sweepStale(top);

  const message = messageFile
    ? readFileSync(messageFile, "utf8")
    : git(["log", "-1", "--format=%B", rev]);
  const range = staged ? ["--cached", base] : [base, rev];

  const changes = parseNameStatus(git(["diff", "--name-status", "-M", ...range]));
  const tests = changes.filter((c) => c.status !== "D" && TEST_FILE.test(c.path));
  const targets = tests.flatMap((t) => {
    const paths = t.status === "R" && t.oldPath ? [t.oldPath, t.path] : [t.path];
    return newTitles(git(["diff", "-M", ...range, "--", ...paths]), t.path).map((title) => ({
      file: t.path,
      title,
    }));
  });
  if (targets.length === 0) return 0;

  const reverts = changes.filter(
    (c) =>
      (REVERTIBLE.test(c.path) && !TEST_FILE.test(c.path)) ||
      (c.oldPath !== undefined && REVERTIBLE.test(c.oldPath) && !TEST_FILE.test(c.oldPath)),
  );
  const results: { file: string; title: string; outcome: Outcome }[] = [];

  if (reverts.length === 0) {
    for (const t of targets) results.push({ ...t, outcome: "INVALID" });
  } else {
    const dir = mkdtempSync(join(tmpdir(), WORKTREE_PREFIX));
    cleanup = () => {
      cleanup = undefined;
      removeWorktree(dir, top);
    };
    // SIGHUP too: an agent's tmux pane closing mid-commit must not orphan the detached children.
    process.once("SIGINT", handleSignal);
    process.once("SIGTERM", handleSignal);
    process.once("SIGHUP", handleSignal);
    try {
      // Locked in the same step as it is created, so a crash can never leave an unlocked (and so
      // never-swept) worktree behind.
      isolatedGit(
        [
          "worktree",
          "add",
          "--quiet",
          "--detach",
          "--lock",
          "--reason",
          `bz-falsify pid=${process.pid}`,
          dir,
          rev,
        ],
        top,
      );
      if (staged) {
        // Bring the worktree to the staged state; the test files must be the new ones. `git show`
        // runs with the inherited environment, because only that sees the real index.
        for (const c of changes) {
          if (c.status === "R" && c.oldPath) rmSync(join(dir, c.oldPath), { force: true });
          const target = join(dir, c.path);
          if (c.status === "D") rmSync(target, { force: true });
          else {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, execFileSync("git", ["show", `:${c.path}`], { cwd: top }));
          }
        }
      }
      for (const c of reverts) {
        if (c.status === "A" || c.status === "C") rmSync(join(dir, c.path), { force: true });
        else if (c.status === "R" && c.oldPath) {
          rmSync(join(dir, c.path), { force: true });
          isolatedGit(["checkout", base, "--", c.oldPath], dir);
        } else isolatedGit(["checkout", base, "--", c.path], dir);
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
      for (const t of targets) results.push({ ...t, outcome: classify(report, t.file, t.title) });
    } finally {
      cleanup?.();
      process.off("SIGINT", handleSignal);
      process.off("SIGTERM", handleSignal);
      process.off("SIGHUP", handleSignal);
    }
  }

  console.log("falsify: new tests run against the source before this change");
  for (const r of results) console.log(`  ${r.outcome.padEnd(8)} ${r.file} › ${r.title}`);

  const survived = results.filter((r) => r.outcome === "SURVIVED");
  if (survived.length > 0) {
    console.error(
      "\nThese tests pass without the change, so they cannot detect it. Make each one assert the " +
        "behaviour the change introduces (bz-write-unit-test).",
    );
    return 1;
  }
  const invalid = results.filter((r) => r.outcome === "INVALID");
  if (invalid.length > 0 && !CONTROL_TRAILER.test(message)) {
    console.error(
      reverts.length === 0
        ? "\nThis change adds tests but no source change to revert."
        : "\nSome tests could not be judged by reverting (new symbols, unparsed titles, load " +
            "errors or timeouts).",
    );
    console.error(
      "Break the code by hand, confirm each test fails on its assertion, and record it in the " +
        "commit message:\n  Control: <what you broke> -> <how the test failed>",
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
    return await main();
  } catch (error) {
    // Ctrl-C reaches a synchronous git child too, which dies of it and makes execFileSync throw.
    const code = signalExitCode(error);
    if (code === undefined) throw error;
    return code;
  }
}

if (isMain(import.meta)) process.exit(await entry());

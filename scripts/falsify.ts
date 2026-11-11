// Falsification harness (docs/standards/testing.md). It answers one question about the tests a
// change adds: would they fail if the source change were not there?
//
// It runs the change's new tests against the *previous* version of the source, in a throwaway
// worktree, and classifies each new test:
//   KILLED    it failed: the test depends on the change. Good.
//   SURVIVED  it passed without the change: it cannot detect the change. Not allowed.
//   INVALID   its file did not load, it timed out, or its title could not be matched: no
//             verdict. Every test of a brand-new symbol lands here, so it needs a hand-run
//             control recorded as a commit trailer:
//             `Control: <what you broke> -> <how the test failed>`.
//
// Usage:
//   node scripts/falsify.ts [<rev>]                  check an existing commit (default HEAD)
//   node scripts/falsify.ts --staged <message-file>  check the staged change (commit-msg hook)

import { execFileSync, spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type Outcome = "KILLED" | "SURVIVED" | "INVALID";
export type Change = { status: string; path: string; oldPath?: string };

const TEST_FILE = /(^|\/)[^/]+\.test\.tsx?$/;
const REVERTIBLE = /^(apps|packages)\/[^/]+\/src\//;
const TITLE = /(?<![.\w])(?:it|test)(?:\.\w+(?:\([^()]*\))?)*\(\s*(["'`])((?:\\.|(?!\1).)+)\1/g;
const TEST_CALL = /(?<![.\w])(?:it|test)(?:\.\w+)*\s*\(/;
const CONTROL_TRAILER = /^Control: .+ -> .+$/m;

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
 * Titles of tests whose `it(...)`/`test(...)` line the change adds. When the added lines call a
 * test but no title can be read, the result is a single `<unparsed test in FILE>` marker, which
 * classifies as INVALID and so forces a Control trailer.
 */
export function newTitles(diff: string, file: string): string[] {
  const titles = new Set<string>();
  let calls = false;
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    if (TEST_CALL.test(line)) calls = true;
    for (const [, quote, title] of line.matchAll(TITLE)) {
      if (title === undefined || (quote === "`" && title.includes("${"))) continue;
      titles.add(unescape(title));
    }
  }
  if (titles.size === 0 && calls) return [`<unparsed test in ${file}>`];
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

// The long steps run asynchronously so a SIGINT or SIGTERM is handled while they run: the
// handler kills the child and removes the temporary worktree.
let running: ChildProcess | undefined;
let cleanup: (() => void) | undefined;

function onSignal(signal: NodeJS.Signals): void {
  running?.kill("SIGKILL");
  cleanup?.();
  process.exit(signal === "SIGINT" ? 130 : 143);
}

function run(cmd: string, args: string[], cwd: string, timeoutMs?: number): Promise<boolean> {
  return new Promise((done) => {
    const child = spawn(cmd, args, { cwd, env: isolatedEnv(), stdio: "ignore" });
    running = child;
    const timer =
      timeoutMs === undefined ? undefined : setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    const finish = (ok: boolean) => {
      clearTimeout(timer);
      running = undefined;
      done(ok);
    };
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

async function install(dir: string): Promise<boolean> {
  return (
    (await run("pnpm", ["install", "--frozen-lockfile", "--offline"], dir)) ||
    run("pnpm", ["install", "--frozen-lockfile", "--prefer-offline"], dir)
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
  isolatedGit(["worktree", "prune"], top);

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
    const dir = mkdtempSync(join(tmpdir(), "bz-falsify-"));
    cleanup = () => {
      cleanup = undefined;
      try {
        isolatedGit(["worktree", "remove", "--force", dir], top);
      } catch {
        rmSync(dir, { recursive: true, force: true });
        spawnSync("git", ["worktree", "prune"], { cwd: top, env: isolatedEnv(), stdio: "ignore" });
      }
    };
    process.once("SIGINT", onSignal);
    process.once("SIGTERM", onSignal);
    try {
      isolatedGit(["worktree", "add", "--quiet", "--detach", dir, rev], top);
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
        300_000,
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
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
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

if (import.meta.main) process.exit(await main());

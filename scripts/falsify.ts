// Falsification harness (docs/standards/testing.md). It answers one question about the tests a
// change adds: would they fail if the source change were not there?
//
// It runs the change's new tests against the *previous* version of the source, in a throwaway
// worktree, and classifies each new test:
//   KILLED    it failed: the test depends on the change. Good.
//   SURVIVED  it passed without the change: it cannot detect the change. Not allowed.
//   INVALID   its file did not load, or it timed out: no verdict. Every test of a brand-new
//             symbol lands here, so it needs a hand-run control recorded as a commit trailer:
//             `Control: <what you broke> -> <how the test failed>`.
//
// Usage:
//   node scripts/falsify.ts [<rev>]                  check an existing commit (default HEAD)
//   node scripts/falsify.ts --staged <message-file>  check the staged change (commit-msg hook)

import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

type Outcome = "KILLED" | "SURVIVED" | "INVALID";
type Change = { status: string; path: string };

const TEST_FILE = /(^|\/)[^/]+\.test\.tsx?$/;
const REVERTIBLE = /^(apps|packages)\/[^/]+\/src\//;
const TITLE = /\b(?:it|test)(?:\.each\([^)]*\))?\(\s*(["'])((?:\\.|(?!\1).)+)\1/g;
const CONTROL_TRAILER = /^Control: .+ -> .+$/m;

const git = (args: string[], cwd?: string) =>
  execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });

function parseNameStatus(out: string): Change[] {
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t");
      return { status: parts[0]?.[0] ?? "", path: parts[parts.length - 1] ?? "" };
    });
}

/** Titles of tests whose `it(...)`/`test(...)` line the change adds. */
function newTitles(diff: string): string[] {
  const titles = new Set<string>();
  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const match of line.matchAll(TITLE)) if (match[2]) titles.add(match[2]);
  }
  return [...titles];
}

type VitestReport = {
  testResults: {
    name: string;
    status: string;
    message?: string;
    assertionResults: { title: string; status: string; failureMessages: string[] }[];
  }[];
};

function isReport(value: unknown): value is VitestReport {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { testResults?: unknown }).testResults)
  );
}

function classify(report: VitestReport, file: string, title: string): Outcome {
  const suite = report.testResults.find((r) => r.name.endsWith(file));
  if (!suite || suite.assertionResults.length === 0) return "INVALID";
  const test = suite.assertionResults.find((a) => a.title === title);
  if (!test) return "INVALID";
  if (test.status === "passed") return "SURVIVED";
  if (test.failureMessages.some((m) => /Test timed out/.test(m))) return "INVALID";
  return test.status === "failed" ? "KILLED" : "INVALID";
}

function main(): number {
  const staged = process.argv[2] === "--staged";
  const messageFile = staged ? process.argv[3] : undefined;
  const rev = staged ? undefined : (process.argv[2] ?? "HEAD");
  const base = staged ? "HEAD" : `${rev}^`;
  const message = messageFile
    ? readFileSync(messageFile, "utf8")
    : git(["log", "-1", "--format=%B", rev ?? "HEAD"]);
  const range = staged ? ["--cached", base] : [base, rev ?? "HEAD"];

  const changes = parseNameStatus(git(["diff", "--name-status", "--no-renames", ...range]));
  const tests = changes.filter((c) => c.status !== "D" && TEST_FILE.test(c.path));
  const targets = tests.flatMap((t) =>
    newTitles(git(["diff", ...range, "--", t.path])).map((title) => ({ file: t.path, title })),
  );
  if (targets.length === 0) return 0;

  const reverts = changes.filter((c) => REVERTIBLE.test(c.path) && !TEST_FILE.test(c.path));
  const results: { file: string; title: string; outcome: Outcome }[] = [];

  if (reverts.length === 0) {
    for (const t of targets) results.push({ ...t, outcome: "INVALID" });
  } else {
    const dir = mkdtempSync(join(tmpdir(), "bz-falsify-"));
    try {
      git(["worktree", "add", "--quiet", "--detach", dir, staged ? "HEAD" : (rev ?? "HEAD")]);
      if (staged) {
        // Bring the worktree to the staged state; the test files must be the new ones.
        for (const c of changes) {
          const target = join(dir, c.path);
          if (c.status === "D") rmSync(target, { force: true });
          else {
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, execFileSync("git", ["show", `:${c.path}`]));
          }
        }
      }
      for (const c of reverts) {
        if (c.status === "A") rmSync(join(dir, c.path), { force: true });
        else git(["checkout", base, "--", c.path], dir);
      }
      execFileSync("pnpm", ["install", "--frozen-lockfile", "--offline"], {
        cwd: dir,
        stdio: "ignore",
      });
      const reportFile = join(dir, "falsify-report.json");
      spawnSync(
        "pnpm",
        [
          "exec",
          "vitest",
          "run",
          ...new Set(targets.map((t) => t.file)),
          "--reporter=json",
          `--outputFile=${reportFile}`,
        ],
        { cwd: dir, stdio: "ignore", timeout: 300_000 },
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
      try {
        git(["worktree", "remove", "--force", dir]);
      } catch {
        rmSync(dir, { recursive: true, force: true });
      }
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
        : "\nSome tests could not be judged by reverting (new symbols, load errors or timeouts).",
    );
    console.error(
      "Break the code by hand, confirm each test fails on its assertion, and record it in the " +
        "commit message:\n  Control: <what you broke> -> <how the test failed>",
    );
    return 1;
  }
  return 0;
}

process.exit(main());

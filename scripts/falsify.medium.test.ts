// Runs scripts/falsify.ts against a branch in a linked worktree of a throwaway repository, with a
// bogus GIT_DIR and GIT_INDEX_FILE in its environment that must never reach git or the tests. A
// stub `pnpm` stands in for install and vitest, and logs what it saw; a stub `cargo-nextest` lists
// the Rust tests named in the tree's rust-tests.txt.

import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const FALSIFY = fileURLToPath(new URL("falsify.ts", import.meta.url));
const SOURCE = "packages/a/src/x.ts";
const TEST = "packages/a/src/x.test.ts";
const CONTROL = "Control: return v = 1 -> caps failed: expected 2, got 1";

const STUB_PNPM = `#!/bin/sh
{
  echo "ARGS: $*"
  env | grep '^GIT_'
  echo "PWD: $(pwd)"
  echo "SOURCE: $(cat ${SOURCE})"
  echo "TEST: $(cat ${TEST})"
} >> "$STUB_LOG"
case "$1" in
  install)
    if [ "\${STUB_FAIL_OFFLINE:-}" = 1 ]; then
      for arg in "$@"; do [ "$arg" = --offline ] && exit 1; done
    fi
    exit 0
    ;;
  exec)
    for arg in "$@"; do
      case "$arg" in --outputFile=*) out="\${arg#--outputFile=}" ;; esac
    done
    printf '{"testResults":[{"name":"%s/${TEST}","status":"failed","assertionResults":[{"title":"caps","status":"%s","failureMessages":[]}]}]}' "$(pwd)" "$STUB_STATUS" > "$out"
    exit 0
    ;;
esac
exit 1
`;

const STUB_NEXTEST = `#!/bin/sh
echo "NEXTEST: $*" >> "$STUB_LOG"
[ "\${STUB_NEXTEST_FAIL:-}" = 1 ] && exit 1
[ -e nextest-fails ] && exit 1
printf '{"rust-suites":{"hook":{"testcases":{'
sep=""
while read -r name; do
  printf '%s"%s":{}' "$sep" "$name"
  sep=","
done < rust-tests.txt
printf '}}}}'
`;

type Fixture = {
  root: string;
  repo: string;
  linked: string;
  tmp: string;
  log: string;
  base: string;
};

let fx: Fixture;

/** The environment for every command: no inherited repository, no user or system git config. */
function env(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return {
    ...clean,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    PATH: `${join(fx.root, "bin")}:${process.env["PATH"] ?? ""}`,
    TMPDIR: fx.tmp,
    STUB_LOG: fx.log,
    STUB_STATUS: "failed",
    ...extra,
  };
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, env: env(), encoding: "utf8" });

function write(dir: string, file: string, text: string): void {
  mkdirSync(join(dir, file, ".."), { recursive: true });
  writeFileSync(join(dir, file), text);
}

beforeEach(() => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "bz-fixture-falsify-")));
  fx = {
    root,
    repo: join(root, "repo"),
    linked: join(root, "linked"),
    tmp: join(root, "tmp"),
    log: join(root, "stub.log"),
    base: "",
  };
  mkdirSync(fx.tmp);
  write(root, "bin/pnpm", STUB_PNPM);
  chmodSync(join(root, "bin/pnpm"), 0o755);
  write(root, "bin/cargo-nextest", STUB_NEXTEST);
  chmodSync(join(root, "bin/cargo-nextest"), 0o755);
  writeFileSync(fx.log, "");

  mkdirSync(fx.repo);
  git(fx.repo, "init", "--quiet", "--initial-branch=main");
  git(fx.repo, "config", "user.name", "Falsify Test");
  git(fx.repo, "config", "user.email", "falsify@example.com");
  write(fx.repo, SOURCE, "export const v = 1;\n");
  write(fx.repo, TEST, 'import { v } from "./x.ts";\nit("v", () => {});\n');
  git(fx.repo, "add", SOURCE, TEST);
  git(fx.repo, "commit", "--quiet", "-m", "feat: v1");
  fx.base = git(fx.repo, "rev-parse", "HEAD").trim();
  git(fx.repo, "worktree", "add", "--quiet", "-b", "work", fx.linked);

  write(fx.linked, SOURCE, "export const v = 2;\n");
  write(
    fx.linked,
    TEST,
    'import { v } from "./x.ts";\nit("v", () => {});\nit("caps", () => {});\n',
  );
  git(fx.linked, "add", SOURCE, TEST);
  git(fx.linked, "commit", "--quiet", "-m", "feat: v2");
});

afterEach(() => {
  rmSync(fx.root, { recursive: true, force: true });
});

function falsify(args: string[], extra: Record<string, string> = {}) {
  const result = spawnSync("node", [FALSIFY, ...args], {
    cwd: fx.linked,
    env: env({
      GIT_DIR: join(fx.root, "bogus.git"),
      GIT_INDEX_FILE: join(fx.root, "bogus-index"),
      ...extra,
    }),
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: result.status, output: result.stdout + result.stderr };
}

const againstBase = (extra: Record<string, string> = {}) => falsify(["--base", fx.base], extra);

const stubLog = () => readFileSync(fx.log, "utf8");
const falsifyWorktrees = (cwd: string) =>
  git(cwd, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree ") && /\/bz-falsify-[^/]*$/.test(line));
const leftovers = () => [...falsifyWorktrees(fx.repo), ...readdirSync(fx.tmp)];

function lockedWorktree(name: string, pid: number): string {
  const path = join(fx.root, name);
  git(fx.repo, "worktree", "add", "--quiet", "--detach", path);
  git(fx.repo, "worktree", "lock", "--reason", `bz-falsify pid=${pid}`, path);
  return path;
}

describe("falsify on a branch in a linked worktree", () => {
  it("runs the new test against the base's source, with no git location variables", () => {
    const result = againstBase();
    expect({
      status: result.status,
      killed: result.output.includes("KILLED"),
      sawGitVars: /^GIT_(DIR|INDEX_FILE|WORK_TREE)=/m.test(stubLog()),
      sawOldSource: stubLog().includes("SOURCE: export const v = 1;"),
      sawNewSource: stubLog().includes("SOURCE: export const v = 2;"),
      sawNewTest: stubLog().includes('it("caps"'),
    }).toEqual({
      status: 0,
      killed: true,
      sawGitVars: false,
      sawOldSource: true,
      sawNewSource: false,
      sawNewTest: true,
    });
  });

  it("leaves the branch's worktree clean and no temporary worktree behind", () => {
    expect(againstBase().status).toBe(0);
    expect({ status: git(fx.linked, "status", "--porcelain"), leftovers: leftovers() }).toEqual({
      status: "",
      leftovers: [],
    });
  });

  it("fails when the new test passes without the change", () => {
    expect(againstBase({ STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringContaining("SURVIVED"),
    });
    expect(leftovers()).toEqual([]);
  });

  it("fails on an INVALID test until a commit on the branch records a control", () => {
    const before = againstBase({ STUB_STATUS: "skipped" });
    git(fx.linked, "commit", "--quiet", "--allow-empty", "-m", "test: control", "-m", CONTROL);
    git(fx.linked, "commit", "--quiet", "--allow-empty", "-m", "chore: later");
    expect({ before, after: againstBase({ STUB_STATUS: "skipped" }).status }).toEqual({
      before: { status: 1, output: expect.stringContaining("INVALID") },
      after: 0,
    });
  });

  it("defaults to the merge base with main, ignoring commits main gained since", () => {
    write(fx.repo, SOURCE, "export const v = 3;\n");
    git(fx.repo, "commit", "--quiet", "-am", "feat: v3");
    expect({ status: falsify([]).status, log: stubLog() }).toEqual({
      status: 0,
      log: expect.stringContaining("SOURCE: export const v = 1;"),
    });
  });

  it("falls back to an online install when the offline one fails", () => {
    expect({ status: againstBase({ STUB_FAIL_OFFLINE: "1" }).status, log: stubLog() }).toEqual({
      status: 0,
      log: expect.stringContaining("--prefer-offline"),
    });
  });

  it("sweeps a stale worktree whose pid is dead and keeps one whose pid is alive", () => {
    const dead = lockedWorktree("bz-falsify-dead", 999_999);
    const live = lockedWorktree("bz-falsify-live", process.pid);
    expect(againstBase().status).toBe(0);
    expect({
      listed: falsifyWorktrees(fx.repo),
      deadFolder: existsSync(dead),
      liveFolder: existsSync(live),
    }).toEqual({ listed: [`worktree ${live}`], deadFolder: false, liveFolder: true });
  });
});

/** Commits a Cargo workspace whose tests are `names`, on the branch. */
function addRustTests(...names: string[]): void {
  write(fx.linked, "Cargo.toml", "[workspace]\n");
  write(fx.linked, "rust-tests.txt", names.map((n) => `${n}\n`).join(""));
  git(fx.linked, "add", "Cargo.toml", "rust-tests.txt");
  git(fx.linked, "commit", "--quiet", "-m", "test: rust", "-m", CONTROL);
}

describe("falsify on a branch that adds Rust tests", () => {
  it("lists no Rust tests on a branch that changes no Rust", () => {
    expect(againstBase().status).toBe(0);
    expect(stubLog()).not.toContain("NEXTEST:");
  });

  it("fails on a new Rust test until a trailer names it by its full path", () => {
    addRustTests("tests::reads_a_frame");
    const before = againstBase();
    git(
      fx.linked,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "test: x",
      "-m",
      "Control: reads_a_frame: x -> y",
    );
    const bareName = againstBase().status;
    git(
      fx.linked,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "test: y",
      "-m",
      "Control: tests::reads_a_frame: x -> y",
    );
    expect({ before, bareName, named: againstBase().status }).toEqual({
      before: { status: 1, output: expect.stringContaining("Control: tests::reads_a_frame:") },
      bareName: 1,
      named: 0,
    });
  });

  it("fails, and leaves nothing behind, when nextest can't list the tests", () => {
    addRustTests("tests::reads_a_frame");
    expect(againstBase({ STUB_NEXTEST_FAIL: "1" })).toEqual({
      status: 1,
      output: expect.stringContaining("nextest list` failed at HEAD"),
    });
    expect(leftovers()).toEqual([]);
  });
});

/** Gives main a Cargo workspace whose tests are `names`, and rebases the branch onto it. */
function rustOnMain(names: string[], extra: Record<string, string> = {}): void {
  write(fx.repo, "Cargo.toml", "[workspace]\n");
  write(fx.repo, "rust-tests.txt", names.map((n) => `${n}\n`).join(""));
  for (const [file, text] of Object.entries(extra)) write(fx.repo, file, text);
  git(fx.repo, "add", "Cargo.toml", "rust-tests.txt", ...Object.keys(extra));
  git(fx.repo, "commit", "--quiet", "-m", "build: rust");
  fx.base = git(fx.repo, "rev-parse", "HEAD").trim();
  git(fx.linked, "rebase", "--quiet", "main");
}

describe("falsify on a branch of a tree that already has Rust", () => {
  it("lists nothing for a branch that changes no Rust", () => {
    rustOnMain(["tests::kept"]);
    expect(againstBase().status).toBe(0);
    expect(stubLog()).not.toContain("NEXTEST:");
  });

  it("lists the base and HEAD, and asks a control only for the test HEAD adds", () => {
    rustOnMain(["tests::kept"]);
    write(fx.linked, "rust-tests.txt", "tests::kept\ntests::added\n");
    write(fx.linked, "crates/x/src/lib.rs", "// a test\n");
    git(fx.linked, "add", "rust-tests.txt", "crates/x/src/lib.rs");
    git(fx.linked, "commit", "--quiet", "-m", "test: rust", "-m", CONTROL);
    const result = againstBase();
    expect({
      status: result.status,
      asksAdded: result.output.includes("Control: tests::added:"),
      asksKept: result.output.includes("Control: tests::kept:"),
      listings: stubLog()
        .split("\n")
        .filter((l) => l.startsWith("NEXTEST:")).length,
    }).toEqual({ status: 1, asksAdded: true, asksKept: false, listings: 2 });
  });

  it("fails, and leaves nothing behind, when the base's tests can't be listed", () => {
    rustOnMain(["tests::kept"], { "nextest-fails": "" });
    git(fx.linked, "rm", "--quiet", "nextest-fails");
    write(fx.linked, "crates/x/src/lib.rs", "// a change\n");
    git(fx.linked, "add", "crates/x/src/lib.rs");
    git(fx.linked, "commit", "--quiet", "-m", "build: fix", "-m", CONTROL);
    expect(againstBase()).toEqual({
      status: 1,
      output: expect.stringContaining("nextest list` failed at the base"),
    });
    expect(leftovers()).toEqual([]);
  });
});

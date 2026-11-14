// Runs scripts/falsify.ts against a branch in a linked worktree of a throwaway repository, with a
// bogus GIT_DIR and GIT_INDEX_FILE in its environment that must never reach git or the tests. A
// stub `pnpm` stands in for install and vitest, and logs what it saw; a stub `cargo-nextest` lists
// the Rust tests named in the tree's rust-tests.txt and runs them, failing each on the line of
// kills.txt whose marker the Rust source holds; a stub `cargo-mutants` lists mutants.json.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
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
import { isAlive } from "@bazhen/host-guard";
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
    if [ "\${STUB_HANG_VITEST:-}" = 1 ]; then
      echo "HANGING $$" >> "$STUB_LOG"
      trap 'echo TERMED >> "$STUB_LOG"' TERM
      i=0
      while [ $i -lt 20 ]; do sleep 1; i=$((i + 1)); done
    fi
    for arg in "$@"; do
      case "$arg" in --outputFile=*) out="\${arg#--outputFile=}" ;; esac
    done
    printf '{"testResults":[{"name":"%s/${TEST}","status":"failed","assertionResults":[{"title":"caps","status":"%s","failureMessages":[]}]}]}' "$(pwd)" "$STUB_STATUS" > "$out"
    exit 0
    ;;
esac
exit 1
`;

const LIB = "crates/x/src/lib.rs";

const STUB_NEXTEST = `#!/bin/sh
echo "NEXTEST: $*" >> "$STUB_LOG"
[ "\${STUB_NEXTEST_FAIL:-}" = 1 ] && exit 1
[ -e nextest-fails ] && exit 1
if [ "$2" = run ]; then
  [ "\${NEXTEST_EXPERIMENTAL_LIBTEST_JSON:-}" = 1 ] || exit 101
  echo "RUN: $(tr '\\n' ' ' < ${LIB})" >> "$STUB_LOG"
  hang=""
  if grep -q MUTATED ${LIB}; then hang="\${STUB_HANG:-}"; else hang="\${STUB_HANG_UNMUTATED:-}"; fi
  if [ "$hang" = 1 ]; then
    echo "HANGING $$" >> "$STUB_LOG"
    if [ "\${STUB_STUBBORN:-}" = 1 ]; then
      # Outlasts SIGTERM, so falsify waits out its grace before SIGKILL.
      trap 'echo TERMED >> "$STUB_LOG"' TERM
      i=0
      while [ $i -lt 20 ]; do sleep 1; i=$((i + 1)); done
    fi
    sleep 60
  fi
  while read -r name; do
    case "$*" in *"test(=$name)"*) ;; *) continue ;; esac
    at=""
    if [ -e kills.txt ]; then
      while IFS='|' read -r marker test location; do
        if [ "$test" = "$name" ] && grep -q "$marker" ${LIB}; then at="$location"; fi
      done < kills.txt
    fi
    printf '{"type":"test","event":"started","name":"hook::hook$%s"}\\n' "$name"
    # A backtrace lists the product frames a panic passed through.
    if [ -n "$at" ] && [ -n "\${RUST_BACKTRACE:-}" ]; then at="$at, at ${LIB}:5:5"; fi
    # A test that leaves state behind passes once, then fails on what it left.
    if [ "\${STUB_LEFTOVER:-}" = 1 ]; then
      if [ -e "$STUB_LOG.state" ]; then at="${LIB}:13:9"; else : > "$STUB_LOG.state"; fi
    fi
    # A flaky test fails once, then passes.
    if [ -n "$at" ] && [ "\${STUB_FLAKY:-}" = 1 ]; then
      if [ -e "$STUB_LOG.flaked" ]; then at=""; else : > "$STUB_LOG.flaked"; fi
    fi
    if [ -n "$at" ]; then
      printf '{"type":"test","event":"failed","name":"hook::hook$%s","stdout":"panicked at %s: assertion failed"}\\n' "$name" "$at"
    else
      printf '{"type":"test","event":"ok","name":"hook::hook$%s"}\\n' "$name"
    fi
  done < rust-tests.txt
  exit 0
fi
suite() {
  printf '"%s":{"package-name":"hook","binary-name":"hook","testcases":{' "$1"
  sep=""
  while read -r name; do
    printf '%s"%s":{}' "$sep" "$name"
    sep=","
  done < "$2"
  printf '}}'
}
printf '{"rust-suites":{'
suite hook rust-tests.txt
# The crate's binary, whose tests share the library's target.
if [ -e bin-tests.txt ]; then printf ','; suite hook::bin/hook bin-tests.txt; fi
printf '}}'
`;

const STUB_MUTANTS = `#!/bin/sh
echo "MUTANTS: $*" >> "$STUB_LOG"
[ "\${STUB_MUTANTS_FAIL:-}" = 1 ] && exit 1
case "$*" in *--in-diff*) ;; *) exit 1 ;; esac
# Only the mutants of the change, and only when given the branch's diff of its Rust source.
for diff in "$@"; do :; done
if [ -e mutants.json ] && grep -q '^+fn b' "$diff"; then cat mutants.json; else echo "[]"; fi
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
    CARGO_HOME: join(fx.root, "cargo-home"),
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
  write(root, "bin/cargo-mutants", STUB_MUTANTS);
  chmodSync(join(root, "bin/cargo-mutants"), 0o755);
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
        .filter((l) => /^NEXTEST: nextest list .*--all-features/.test(l)).length,
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

const LIB_BEFORE = "fn a() -> u8 {\n    1\n}\n";
// `b`, then its tests, as rustfmt writes them; the tests' lines are 8 to 15.
const LIB_AFTER = [
  LIB_BEFORE,
  "fn b() -> u8 {\n    2\n}\n",
  "\n#[cfg(test)]\nmod tests {\n    use super::*;\n\n    fn twice() {\n        assert_eq!(b(), 2);\n    }\n}\n",
].join("");
const B_SPAN = { start: { line: 4, column: 1 }, end: { line: 6, column: 2 } };

/** A cargo-mutants listing entry for a mutant of `b`, whose patch makes `from` into `to`. */
function mutantOfB(name: string, from = "    2", to = "    0 /* MUTATED */") {
  return {
    name: `${LIB}:5:5: ${name}`,
    file: LIB,
    span: { start: { line: 5, column: 5 }, end: { line: 5, column: 6 } },
    function: { function_name: "b", return_type: "-> u8", span: B_SPAN },
    diff: `--- ${LIB}\n+++ ${name}\n@@ -4,3 +4,3 @@\n fn b() -> u8 {\n-${from}\n+${to}\n }\n`,
  };
}

const ASSERTION = `${LIB}:13:9`;
const IN_PRODUCT = `${LIB}:5:5`;
const IN_UNCHANGED_PRODUCT = `${LIB}:2:5`;

/**
 * Main has a crate whose test is tests::kept; the branch adds `b` and `tests`, with these mutants
 * listed and these `marker|test|panic location` kills, under a trailer that names no Rust test.
 */
function mutatedBranch(
  tests: string[],
  mutants: unknown[],
  kills: string[] = [],
  extra: Record<string, string> = {},
): void {
  rustOnMain(["tests::kept"], { [LIB]: LIB_BEFORE });
  write(fx.linked, LIB, LIB_AFTER);
  write(fx.linked, "rust-tests.txt", ["tests::kept", ...tests].map((n) => `${n}\n`).join(""));
  write(fx.linked, "mutants.json", JSON.stringify(mutants));
  write(fx.linked, "kills.txt", kills.map((k) => `${k}\n`).join(""));
  for (const [file, text] of Object.entries(extra)) write(fx.linked, file, text);
  const files = ["rust-tests.txt", "mutants.json", "kills.txt"];
  git(fx.linked, "add", LIB, ...files, ...Object.keys(extra));
  git(fx.linked, "commit", "--quiet", "-m", "feat: b", "-m", CONTROL);
}

const runs = () => stubLog().match(/^RUN: /gm)?.length ?? 0;

describe("falsify judging new Rust tests by mutating the change", () => {
  it("needs no trailer for a test a mutant fails on its assertion, and names the mutant", () => {
    mutatedBranch(
      ["tests::b_is_two"],
      [mutantOfB("replace b -> u8 with 0")],
      [`MUTATED|tests::b_is_two|${ASSERTION}`],
    );
    const result = againstBase();
    expect({
      status: result.status,
      killed: result.output.includes(
        `KILLED   hook › tests::b_is_two (by ${LIB}:5:5: replace b -> u8 with 0)`,
      ),
      ranMutated: stubLog().includes("RUN: fn a() -> u8 {     1 } fn b() -> u8 {     0 /*"),
      ranUnmutatedFirst: stubLog().indexOf("RUN: fn a() -> u8 {     1 } fn b() -> u8 {     2"),
      ranKept: stubLog().includes("test(=tests::kept)"),
    }).toEqual({
      status: 0,
      killed: true,
      ranMutated: true,
      ranUnmutatedFirst: stubLog().indexOf("RUN: "),
      ranKept: false,
    });
    expect({ status: git(fx.linked, "status", "--porcelain"), leftovers: leftovers() }).toEqual({
      status: "",
      leftovers: [],
    });
  });

  it("keeps the caller's RUST_BACKTRACE out of the run, whose frames would read as a crash", () => {
    mutatedBranch(
      ["tests::b_is_two"],
      [mutantOfB("replace b -> u8 with 0")],
      [`MUTATED|tests::b_is_two|${ASSERTION}`],
    );
    expect(againstBase({ RUST_BACKTRACE: "1" })).toEqual({
      status: 0,
      output: expect.stringContaining("KILLED   hook › tests::b_is_two"),
    });
  });

  it("still asks a trailer naming a test no mutant fails", () => {
    mutatedBranch(
      ["tests::b_is_two", "tests::weak"],
      [mutantOfB("replace b -> u8 with 0")],
      [`MUTATED|tests::b_is_two|${ASSERTION}`],
    );
    const result = againstBase();
    expect({
      status: result.status,
      asksWeak: result.output.includes("Control: tests::weak:"),
      asksKilled: result.output.includes("Control: tests::b_is_two:"),
    }).toEqual({ status: 1, asksWeak: true, asksKilled: false });
  });

  it("doesn't count a failure whose panic is in product code", () => {
    mutatedBranch(
      ["tests::b_is_two"],
      [mutantOfB("replace b -> u8 with 0")],
      [`MUTATED|tests::b_is_two|${IN_PRODUCT}`],
    );
    const result = againstBase();
    expect({
      status: result.status,
      unkilled: result.output.includes(
        "tests::b_is_two (Rust: no mutant of the change failed it on an assertion",
      ),
      runs: runs(),
    }).toEqual({ status: 1, unkilled: true, runs: 2 });
  });

  it("doesn't count a panic in product code the branch didn't change", () => {
    mutatedBranch(
      ["tests::b_is_two"],
      [mutantOfB("replace b -> u8 with 0")],
      [`MUTATED|tests::b_is_two|${IN_UNCHANGED_PRODUCT}`],
    );
    const result = againstBase();
    expect({
      status: result.status,
      unkilled: result.output.includes(
        "tests::b_is_two (Rust: no mutant of the change failed it on an assertion",
      ),
      runs: runs(),
    }).toEqual({ status: 1, unkilled: true, runs: 2 });
  });

  it("doesn't credit a test that fails from what an earlier run left, mutant or not", () => {
    // Like `File::create_new(temp_dir().join(..)).unwrap()`: it passes once, then fails on its
    // own leftover, asserting nothing about the code.
    mutatedBranch(["tests::b_is_two"], [mutantOfB("replace b -> u8 with 0")]);
    const result = againstBase({ STUB_LEFTOVER: "1" });
    expect({
      status: result.status,
      asks: result.output.includes("Control: tests::b_is_two:"),
      runs: runs(),
    }).toEqual({ status: 1, asks: true, runs: 4 });
  });

  it("says a mutant's run timed out, and judges the test by the others", () => {
    mutatedBranch(["tests::b_is_two"], [mutantOfB("replace b -> u8 with 0")]);
    const result = againstBase({ STUB_HANG: "1", FALSIFY_RUST_TIMEOUT_MS: "2000" });
    expect({
      status: result.status,
      timedOut: result.output.includes(
        `INVALID  mutant ${LIB}:5:5: replace b -> u8 with 0 (its run timed out after 2 s)`,
      ),
      asks: result.output.includes("Control: tests::b_is_two:"),
    }).toEqual({ status: 1, timedOut: true, asks: true });
  }, 20_000);

  it("says the unmutated run timed out, rather than that the test fails", () => {
    mutatedBranch(["tests::b_is_two"], [mutantOfB("replace b -> u8 with 0")]);
    const result = againstBase({ STUB_HANG_UNMUTATED: "1", FALSIFY_RUST_TIMEOUT_MS: "2000" });
    expect({
      status: result.status,
      timedOut: result.output.includes(
        "tests::b_is_two (Rust: the unmutated run timed out after 2 s",
      ),
    }).toEqual({ status: 1, timedOut: true });
  }, 20_000);

  it("doesn't credit a test that fails under a mutant only once", () => {
    mutatedBranch(
      ["tests::b_is_two"],
      [mutantOfB("replace b -> u8 with 0")],
      [`MUTATED|tests::b_is_two|${ASSERTION}`],
    );
    const result = againstBase({ STUB_FLAKY: "1" });
    expect({
      status: result.status,
      asks: result.output.includes("Control: tests::b_is_two:"),
      runs: runs(),
    }).toEqual({ status: 1, asks: true, runs: 3 });
  });

  it("credits each test to the first mutant that fails it, and stops running it", () => {
    mutatedBranch(
      ["tests::t1", "tests::t2"],
      [
        mutantOfB("replace b -> u8 with 0", "    2", "    0 /* ZERO */"),
        mutantOfB("replace b -> u8 with 1", "    2", "    1 /* ONE */"),
      ],
      [`ZERO|tests::t1|${ASSERTION}`, `ONE|tests::t1|${ASSERTION}`, `ONE|tests::t2|${ASSERTION}`],
    );
    const result = againstBase();
    expect({
      status: result.status,
      t1: result.output.includes("tests::t1 (by crates/x/src/lib.rs:5:5: replace b -> u8 with 0)"),
      t2: result.output.includes("tests::t2 (by crates/x/src/lib.rs:5:5: replace b -> u8 with 1)"),
      runsOfT1: stubLog().match(/^NEXTEST: nextest run .*test\(=tests::t1\)/gm)?.length,
    }).toEqual({ status: 0, t1: true, t2: true, runsOfT1: 4 });
  });

  it("doesn't judge a test whose name can't be selected alone", () => {
    mutatedBranch(["tests::case(1)"], [mutantOfB("replace b -> u8 with 0")]);
    expect(againstBase()).toEqual({
      status: 1,
      output: expect.stringContaining(
        "tests::case(1) (Rust: its name can't be selected to run alone",
      ),
    });
  });

  it("doesn't judge two new tests that share a name in their crate", () => {
    mutatedBranch(
      ["tests::dup"],
      [mutantOfB("replace b -> u8 with 0")],
      [`MUTATED|tests::dup|${ASSERTION}`],
      { "bin-tests.txt": "tests::dup\n" },
    );
    const result = againstBase();
    expect({
      status: result.status,
      shared: result.output.match(/tests::dup \(Rust: another new test in its crate has that name/g)
        ?.length,
    }).toEqual({ status: 1, shared: 2 });
  });

  it("doesn't judge a new test named as one the base has elsewhere in its crate", () => {
    mutatedBranch([], [mutantOfB("replace b -> u8 with 0")], [`MUTATED|tests::kept|${ASSERTION}`], {
      "bin-tests.txt": "tests::kept\n",
    });
    expect(againstBase()).toEqual({
      status: 1,
      output: expect.stringContaining(
        "tests::kept (Rust: the base has a test of that name in its crate",
      ),
    });
  });

  it.each([
    ["above its worktree", () => join(fx.tmp, ".cargo")],
    ["in CARGO_HOME", () => join(fx.root, "cargo-home")],
  ] as const)("refuses a cargo config %s, which could change what the tests run", (_where, dir) => {
    mutatedBranch(["tests::b_is_two"], [mutantOfB("replace b -> u8 with 0")]);
    const config = join(dir(), "config.toml");
    write("/", config, '[env]\nFALSIFY_FIXTURE = "1"\n');
    const result = againstBase();
    expect({
      status: result.status,
      refused: result.output.includes(`${config} sets`),
      ran: stubLog().includes("NEXTEST:"),
      worktrees: falsifyWorktrees(fx.repo),
      tmp: readdirSync(fx.tmp).filter((name) => name !== ".cargo"),
    }).toEqual({ status: 1, refused: true, ran: false, worktrees: [], tmp: [] });
  });

  it("doesn't judge a test that fails without a mutant", () => {
    mutatedBranch(
      ["tests::b_is_two"],
      [mutantOfB("replace b -> u8 with 0")],
      [`fn b|tests::b_is_two|${ASSERTION}`],
    );
    expect(againstBase()).toEqual({
      status: 1,
      output: expect.stringContaining("tests::b_is_two (Rust: fails or doesn't run unmutated"),
    });
  });

  it("reports a mutant whose patch leaves the file unchanged, and never runs it", () => {
    mutatedBranch(
      ["tests::b_is_two"],
      [
        mutantOfB("stale context", "    3", "    0 /* MUTATED */"),
        mutantOfB("no-op", "    2", "    2"),
        mutantOfB("replace b -> u8 with 0"),
      ],
      [`MUTATED|tests::b_is_two|${ASSERTION}`],
    );
    const result = againstBase();
    expect({
      status: result.status,
      stale: result.output.includes(`INVALID  mutant ${LIB}:5:5: stale context (its patch left`),
      noOp: result.output.includes(`INVALID  mutant ${LIB}:5:5: no-op (its patch left`),
      killedBy: result.output.includes("(by crates/x/src/lib.rs:5:5: replace b -> u8 with 0)"),
      runs: runs(),
      summary: result.output.includes("1 of the change's 3 Rust mutants run"),
    }).toEqual({ status: 0, stale: true, noOp: true, killedBy: true, runs: 4, summary: true });
  });

  it("stops once every new test is killed", () => {
    mutatedBranch(
      ["tests::b_is_two"],
      [
        mutantOfB("replace b -> u8 with 0"),
        mutantOfB("replace b -> u8 with 1", "    2", "    1 /* MUTATED */"),
      ],
      [`MUTATED|tests::b_is_two|${ASSERTION}`],
    );
    expect({ status: againstBase().status, runs: runs() }).toEqual({ status: 0, runs: 4 });
  });

  it("runs at most 100 mutants, and says so of a test none of them failed", () => {
    const mutants = Array.from({ length: 101 }, (_, i) => mutantOfB(`mutant ${i}`));
    mutatedBranch(["tests::b_is_two"], mutants);
    const result = againstBase();
    expect({
      status: result.status,
      capped: result.output.includes("no mutant failed it on an assertion within the first 100"),
      summary: result.output.includes("100 of the change's 101 Rust mutants run"),
      runs: runs(),
    }).toEqual({ status: 1, capped: true, summary: true, runs: 101 });
  }, 60_000);

  it("doesn't say it stopped early when it ran every mutant", () => {
    // One that doesn't apply, so 101 are listed and every one that applies runs.
    const mutants = [
      mutantOfB("stale context", "    3", "    0 /* MUTATED */"),
      ...Array.from({ length: 100 }, (_, i) => mutantOfB(`mutant ${i}`)),
    ];
    mutatedBranch(["tests::b_is_two"], mutants);
    const result = againstBase();
    expect({
      capped: result.output.includes("within the first 100"),
      unkilled: result.output.includes("no mutant of the change failed it on an assertion"),
    }).toEqual({ capped: false, unkilled: true });
  }, 60_000);

  it("fails with the install command, and leaves nothing behind, when cargo-mutants can't list", () => {
    mutatedBranch(["tests::b_is_two"], [mutantOfB("replace b -> u8 with 0")]);
    const result = againstBase({ STUB_MUTANTS_FAIL: "1" });
    expect({
      status: result.status,
      hint: result.output.includes("cargo install --locked cargo-mutants@27.1.0"),
      judged: result.output.includes("falsify: new tests run"),
    }).toEqual({ status: 1, hint: true, judged: false });
    expect(leftovers()).toEqual([]);
  });

  it.each([
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)(
    "on %s mid-mutant, stops the run and leaves the checkout clean and no worktree behind",
    async (signal, code) => {
      mutatedBranch(["tests::b_is_two"], [mutantOfB("replace b -> u8 with 0")]);
      const child = spawn("node", [FALSIFY, "--base", fx.base], {
        cwd: fx.linked,
        env: env({ STUB_HANG: "1" }),
        stdio: "ignore",
      });
      const exited = once(child, "exit");
      await expect.poll(() => stubLog().includes("HANGING"), { timeout: 20_000 }).toBe(true);
      const nextest = Number(/^HANGING (\d+)$/m.exec(stubLog())?.[1]);
      child.kill(signal);
      const [status] = await exited;
      await expect.poll(() => isAlive(nextest), { timeout: 5000 }).toBe(false);
      expect({
        status,
        checkout: git(fx.linked, "status", "--porcelain"),
        source: readFileSync(join(fx.linked, LIB), "utf8"),
        leftovers: leftovers(),
      }).toEqual({ status: code, checkout: "", source: LIB_AFTER, leftovers: [] });
    },
    30_000,
  );

  it.each([
    ["Rust", (): void => mutatedBranch(["tests::b_is_two"], [mutantOfB("replace b -> u8 with 0")])],
    ["TypeScript", (): void => undefined],
  ] as const)(
    "on a second Ctrl-C while it stops the %s run, still stops it and removes its worktree",
    async (_path, branch) => {
      branch();
      const child = spawn("node", [FALSIFY, "--base", fx.base], {
        cwd: fx.linked,
        env: env({ STUB_HANG: "1", STUB_HANG_VITEST: "1", STUB_STUBBORN: "1" }),
        stdio: "ignore",
      });
      const exited = once(child, "exit");
      await expect.poll(() => stubLog().includes("HANGING"), { timeout: 20_000 }).toBe(true);
      const stub = Number(/^HANGING (\d+)$/m.exec(stubLog())?.[1]);
      child.kill("SIGINT");
      await expect.poll(() => stubLog().includes("TERMED"), { timeout: 5000 }).toBe(true);
      // Still waiting out the grace, so the second Ctrl-C lands while it stops.
      expect({ exitCode: child.exitCode, signalCode: child.signalCode }).toEqual({
        exitCode: null,
        signalCode: null,
      });
      child.kill("SIGINT");
      const [status, signal] = await exited;
      await expect.poll(() => isAlive(stub), { timeout: 5000 }).toBe(false);
      expect({ status, signal, leftovers: leftovers() }).toEqual({
        status: 130,
        signal: null,
        leftovers: [],
      });
    },
    30_000,
  );
});

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

const LIB = "crates/x/src/lib.rs";

const STUB_NEXTEST = `#!/bin/sh
echo "NEXTEST: $*" >> "$STUB_LOG"
[ "\${STUB_NEXTEST_FAIL:-}" = 1 ] && exit 1
[ -e nextest-fails ] && exit 1
if [ "$2" = run ]; then
  [ "\${NEXTEST_EXPERIMENTAL_LIBTEST_JSON:-}" = 1 ] || exit 101
  echo "RUN: $(tr '\\n' ' ' < ${LIB})" >> "$STUB_LOG"
  if [ "\${STUB_HANG:-}" = 1 ] && grep -q MUTATED ${LIB}; then
    echo HANGING >> "$STUB_LOG"
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
    if [ -n "$at" ]; then
      printf '{"type":"test","event":"failed","name":"hook::hook$%s","stdout":"panicked at %s: assertion failed"}\\n' "$name" "$at"
    else
      printf '{"type":"test","event":"ok","name":"hook::hook$%s"}\\n' "$name"
    fi
  done < rust-tests.txt
  exit 0
fi
printf '{"rust-suites":{"hook":{"package-name":"hook","binary-name":"hook","testcases":{'
sep=""
while read -r name; do
  printf '%s"%s":{}' "$sep" "$name"
  sep=","
done < rust-tests.txt
printf '}}}}'
`;

const STUB_MUTANTS = `#!/bin/sh
echo "MUTANTS: $*" >> "$STUB_LOG"
[ "\${STUB_MUTANTS_FAIL:-}" = 1 ] && exit 1
if [ -e mutants.json ]; then cat mutants.json; else echo "[]"; fi
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
const LIB_AFTER = `${LIB_BEFORE}fn b() -> u8 {\n    2\n}\n`;
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

const ASSERTION = `${LIB}:20:9`;
const IN_PRODUCT = `${LIB}:5:5`;

/**
 * Main has a crate whose test is tests::kept; the branch adds `b` and `tests`, with these mutants
 * listed and these `marker|test|panic location` kills, under a trailer that names no Rust test.
 */
function mutatedBranch(tests: string[], mutants: unknown[], kills: string[] = []): void {
  rustOnMain(["tests::kept"], { [LIB]: LIB_BEFORE });
  write(fx.linked, LIB, LIB_AFTER);
  write(fx.linked, "rust-tests.txt", ["tests::kept", ...tests].map((n) => `${n}\n`).join(""));
  write(fx.linked, "mutants.json", JSON.stringify(mutants));
  write(fx.linked, "kills.txt", kills.map((k) => `${k}\n`).join(""));
  git(fx.linked, "add", LIB, "rust-tests.txt", "mutants.json", "kills.txt");
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
    expect(againstBase()).toEqual({
      status: 1,
      output: expect.stringContaining("Control: tests::b_is_two:"),
    });
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
    }).toEqual({ status: 0, stale: true, noOp: true, killedBy: true, runs: 2 });
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
    expect({ status: againstBase().status, runs: runs() }).toEqual({ status: 0, runs: 2 });
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
      child.kill(signal);
      const [status] = await exited;
      expect({
        status,
        checkout: git(fx.linked, "status", "--porcelain"),
        source: readFileSync(join(fx.linked, LIB), "utf8"),
        leftovers: leftovers(),
      }).toEqual({ status: code, checkout: "", source: LIB_AFTER, leftovers: [] });
    },
    30_000,
  );
});

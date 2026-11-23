// Runs scripts/falsify.ts against a branch in a linked worktree of a throwaway repository, with a
// bogus GIT_DIR and GIT_INDEX_FILE in its environment that must never reach git or the tests. A
// stub `pnpm` stands in for install and vitest, and a stub `cargo` for the binaries' build and
// their listing, each logging what it saw: the build makes a binary of each crate with a
// src/main.rs, in the profile it is given, that prints that file. A stub `cargo-nextest` lists the
// Rust tests named in the tree's rust-tests.txt and runs them, failing each on the line of
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
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cappedScope, isAlive, signalOwnChild } from "@bazhen/host-guard";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCommand } from "./rust-gate.ts";
import { binariesOf, manifestNames, namedBinaries } from "./falsify.ts";
import { inSignalSandbox } from "./signal-paths.ts";

const FALSIFY = fileURLToPath(new URL("falsify.ts", import.meta.url));
// The variable naming the daemon the api suite starts, which falsify sets to run a test on the Rust
// daemon.
const SELECTOR = "BAZHEN_TEST_DAEMON_BIN";
const REPORTER = fileURLToPath(new URL("falsify-reporter.ts", import.meta.url));
const SOURCE = "packages/a/src/x.ts";
const CLI_MAIN = "crates/bazhen/src/main.rs";
const TEST = "packages/a/src/x.test.ts";
const CONTROL = `Control: ${TEST} › caps: return v = 1 -> expected 2, got 1`;
const ASKS_CONTROL = `  Control: ${TEST} › caps: <what you broke> -> <how it failed>`;

/** A test call whose title falsify can't read, split so this file's own line isn't one. */
const UNREADABLE = ["it", "(name, () => {});"].join("");

const STUB_PNPM = `#!/bin/sh
{
  echo "ARGS: $*"
  env | grep '^GIT_'
  echo "PWD: $(pwd)"
  echo "SOURCE: $(cat "\${STUB_SOURCE:-${SOURCE}}")"
  echo "TEST: $(cat "\${STUB_TEST:-${TEST}}")"
} >> "$STUB_LOG"
case "$1" in
  install)
    if [ "\${STUB_FAIL_INSTALL:-}" = 1 ]; then
      for arg in "$@"; do mode="$arg"; done
      i=1
      while [ $i -le 25 ]; do echo "pnpm $mode line $i" >&2; i=$((i + 1)); done
      exit 1
    fi
    if [ "\${STUB_FAIL_OFFLINE:-}" = 1 ]; then
      for arg in "$@"; do [ "$arg" = --offline ] && exit 1; done
    fi
    # As pnpm does: the dependencies' builds run with the install unless scripts are ignored.
    case " $* " in *" --ignore-scripts "*) ;; *) : > .stub-deps-built ;; esac
    exit 0
    ;;
  rebuild)
    if [ "\${STUB_FAIL_REBUILD:-}" = 1 ]; then
      echo "ERR_PNPM_IGNORED_BUILDS Ignored build scripts: stub-dep@1.0.0"
      exit 1
    fi
    : > .stub-deps-built
    exit 0
    ;;
  exec)
    if [ "$3" = list ]; then
      if [ "\${STUB_FAIL_LIST:-}" = 1 ]; then
        echo "Error: stub config failed to load" >&2
        exit 1
      fi
      for arg in "$@"; do
        case "$arg" in --json=*) listing="\${arg#--json=}" ;; esac
      done
      printf '[' > "$listing"
      sep=""
      for arg in "$@"; do
        case "$arg" in
          *.test.ts)
            project=unit
            case "$arg" in tests/api/*) project=api ;; esac
            printf '%s{"file":"%s/%s","projectName":"%s"}' "$sep" "$(pwd)" "$arg" "$project" >> "$listing"
            sep=","
            # As when two projects' include patterns both match a file.
            if [ -n "\${STUB_ALSO_PROJECT:-}" ]; then
              printf ',{"file":"%s/%s","projectName":"%s"}' "$(pwd)" "$arg" "$STUB_ALSO_PROJECT" >> "$listing"
            fi
            ;;
        esac
      done
      printf ']' >> "$listing"
      exit 0
    fi
    echo "VITEST: $*" >> "$STUB_LOG"
    for bin in target/*/*; do
      [ -f "$bin" ] && echo "RAN $bin: $("$bin")" >> "$STUB_LOG"
    done
    if [ -n "\${BAZHEN_CLI:-}" ]; then
      echo "CLI: $BAZHEN_CLI" >> "$STUB_LOG"
      "$BAZHEN_CLI" >> "$STUB_LOG"
    fi
    # A run against the Rust daemon has a status and a report of its own.
    if [ -n "\${${SELECTOR}:-}" ]; then
      echo "DAEMON: $${SELECTOR}: $("$${SELECTOR}")" >> "$STUB_LOG"
      STUB_STATUS="\${STUB_RUST_STATUS:-$STUB_STATUS}"
      STUB_VITEST_REPORT="\${STUB_RUST_REPORT:-\${STUB_VITEST_REPORT:-}}"
      STUB_FAILURE="\${STUB_RUST_FAILURE:-\${STUB_FAILURE:-}}"
      STUB_TITLE="\${STUB_RUST_TITLE:-\${STUB_TITLE:-}}"
    fi
    if [ "\${STUB_HANG_VITEST:-}" = 1 ]; then
      # What falsify's reporter records of a run stopped while its second test ran, mid-write.
      if [ "\${STUB_RECORD:-}" = 1 ]; then
        file="$(pwd)/${TEST}"
        printf '{"kind":"collected","file":"%s","tests":[{"id":"c","title":"caps"},{"id":"h","title":"hangs"}]}\\n' "$file" >> "$BZ_FALSIFY_RESULTS_FILE"
        printf '{"kind":"result","file":"%s","id":"c","status":"failed","failureMessages":["AssertionError: expected 1 to be 2"]}\\n' "$file" >> "$BZ_FALSIFY_RESULTS_FILE"
        printf '{"kind":"result","file":"%s","id":"h","status":"pass' "$file" >> "$BZ_FALSIFY_RESULTS_FILE"
      fi
      trap 'echo TERMED >> "$STUB_LOG"' TERM
      echo "HANGING $$" >> "$STUB_LOG"
      echo "stub vitest: still running" >&2
      i=0
      while [ $i -lt 20 ]; do sleep 1; i=$((i + 1)); done
    fi
    # A test that starts falsify again, in the worktree falsify is running it in.
    if [ "\${STUB_NEST:-0}" -gt 0 ]; then
      STUB_NEST=$((STUB_NEST - 1)) node "$STUB_FALSIFY" --base "$STUB_BASE" >> "$STUB_LOG" 2>&1
      echo "NESTED EXIT $?" >> "$STUB_LOG"
    fi
    for arg in "$@"; do
      case "$arg" in --outputFile=*) out="\${arg#--outputFile=}" ;; esac
    done
    if [ -n "\${STUB_VITEST_EXIT:-}" ]; then
      i=1
      while [ $i -le 25 ]; do echo "stub vitest line $i" >&2; i=$((i + 1)); done
      echo "stub vitest: 1 project failed to start"
      printf 'Error: \\033[31mglobal setup failed\\033[39m\\r\\n' >&2
      exit "$STUB_VITEST_EXIT"
    fi
    if [ -n "\${STUB_ALSO_PROJECT:-}" ]; then
      case " $* " in *" --project $STUB_ALSO_PROJECT "*) echo "stub vitest: done"; exit 0 ;; esac
    fi
    case "\${STUB_VITEST_REPORT:-}" in
      none) echo "stub vitest: done"; exit 0 ;;
      garbage) echo "not json" > "$out"; exit 0 ;;
      wrong) echo '{"results":[]}' > "$out"; exit 0 ;;
      dir) mkdir "$out"; exit 0 ;;
    esac
    # Each file the run names, with STUB_EACH; else only the one test file the case judges.
    files="\${STUB_TEST:-${TEST}}"
    if [ "\${STUB_EACH:-}" = 1 ]; then
      files=""
      for arg in "$@"; do
        case "$arg" in *.test.ts) files="$files $arg" ;; esac
      done
    fi
    # A test fails, whatever the source, while a dependency's build it needs hasn't run.
    status="$STUB_STATUS"
    failure="\${STUB_FAILURE:-}"
    if [ ! -e .stub-deps-built ]; then
      status=failed
      failure="Error: stub-dep is not built"
    fi
    messages=""
    [ -n "$failure" ] && messages="\\"$failure\\""
    printf '{"testResults":[' > "$out"
    sep=""
    for file in $files; do
      st="$status"
      msg="$messages"
      # A test of a symbol the source lacks: while a file under packages/ holds STUB_LOAD_IF, each
      # file run throws as it loads.
      if [ -n "\${STUB_LOAD_IF:-}" ] && grep -rqsF -- "$STUB_LOAD_IF" packages; then
        printf '%s{"name":"%s/%s","status":"failed","message":"SyntaxError: no export named w","assertionResults":[]}' "$sep" "$(pwd)" "$file" >> "$out"
        sep=","
        continue
      fi
      # A break: while a file under packages/ holds STUB_FAIL_IF, each of STUB_FAIL_FILES (else
      # each file run) fails, on an assertion at its own frame or with STUB_FAIL_AS, or, with
      # STUB_FAIL_LOAD, by a throw as it loads.
      if [ -n "\${STUB_FAIL_IF:-}" ] && grep -rqsF -- "$STUB_FAIL_IF" packages; then
        case " \${STUB_FAIL_FILES:-$file} " in
          *" $file "*)
            if [ "\${STUB_FAIL_LOAD:-}" = 1 ]; then
              printf '%s{"name":"%s/%s","status":"failed","message":"Error: boom as it loaded","assertionResults":[]}' "$sep" "$(pwd)" "$file" >> "$out"
              sep=","
              continue
            fi
            st=failed
            msg="\\"\${STUB_FAIL_AS:-AssertionError: expected 2 to be 3\\n    at $file:3:5}\\""
            ;;
        esac
      fi
      printf '%s{"name":"%s/%s","status":"failed","assertionResults":[{"title":"%s","status":"%s","failureMessages":[%s]}]}' "$sep" "$(pwd)" "$file" "\${STUB_TITLE:-caps}" "$st" "$msg" >> "$out"
      sep=","
    done
    printf ']}' >> "$out"
    exit 0
    ;;
esac
exit 1
`;

const LIB = "crates/x/src/lib.rs";

// falsify runs each mutant's tests in a capped scope of their own, at half a second a run, which
// these tests skip but for those of the containment itself and of stopping a run, which it changes.
const CONTAINED = { BZ_FALSIFY_UNCONTAINED: "0" };
// A test whose runs are each contained: a capped scope costs seconds a run on CI.
const CONTAINED_TIMEOUT_MS = 20_000;
// A capped scope's run of its own is one systemd stops: elsewhere a session escapes it.
const inCappedScope = cappedScope() !== undefined;

const STUB_NEXTEST = `#!/bin/sh
echo "NEXTEST: $*" >> "$STUB_LOG"
[ "\${STUB_NEXTEST_FAIL:-}" = 1 ] && exit 1
[ -e nextest-fails ] && exit 1
if [ "$2" = run ]; then
  [ "\${NEXTEST_EXPERIMENTAL_LIBTEST_JSON:-}" = 1 ] || exit 101
  echo "RUN: $(tr '\\n' ' ' < ${LIB})" >> "$STUB_LOG"
  hang=""
  if grep -q MUTATED ${LIB}; then hang="\${STUB_HANG:-}"; else hang="\${STUB_HANG_UNMUTATED:-}"; fi
  # As capped's runner names a test process a memory cap killed.
  if grep -q MUTATED ${LIB} && [ "\${STUB_MEMORY_KILL:-}" = 1 ]; then echo hook >> "$BZ_CAPPED_KILLS"; fi
  # As a test's holder does: a process in a session of its own, which outlives the test, under a
  # mutant or, as a leak of the test's own, without one. Without job control it leads no group, so
  # setsid keeps its pid and $! names it.
  if grep -q MUTATED ${LIB}; then session="\${STUB_SESSION:-}"; else session="\${STUB_SESSION_UNMUTATED:-}"; fi
  if [ -n "$session" ]; then
    setsid sleep "$session" > /dev/null 2>&1 &
    echo "SESSION $!" >> "$STUB_LOG"
  fi
  if [ "$hang" = 1 ]; then
    # Trapped before HANGING is logged: a test signals as soon as it reads HANGING, and a SIGTERM
    # that lands first would end the stub without TERMED.
    [ "\${STUB_STUBBORN:-}" = 1 ] && trap 'echo TERMED >> "$STUB_LOG"' TERM
    echo "HANGING $$" >> "$STUB_LOG"
    if [ "\${STUB_STUBBORN:-}" = 1 ]; then
      # Outlasts SIGTERM, so falsify waits out its grace before SIGKILL.
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
    # As nextest reports a test it ended at its time limit.
    if [ "$name" = "\${STUB_SLOW_UNMUTATED:-}" ] && ! grep -q MUTATED ${LIB}; then
      printf '{"type":"test","event":"failed","name":"hook::hook$%s","reason":"time limit exceeded"}\\n' "$name"
    elif [ -n "$at" ]; then
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

// \`cargo metadata\`: each crate whose manifest is \`[package]\\nname = "<crate's folder>"\`, with a
// binary of that name when it has a src/main.rs.
const STUB_CARGO = `#!/bin/sh
echo "CARGO: $*" >> "$STUB_LOG"
if [ "$1" = build ]; then
  echo "BUILD: $* in $(pwd) to $CARGO_TARGET_DIR" >> "$STUB_LOG"
  if [ "\${STUB_FAIL_BUILD:-}" = 1 ]; then
    echo "   Compiling bazhen v0.1.0" >&2
    echo "error[E0425]: cannot find value \\\`x\\\` in this scope" >&2
    i=1
    while [ $i -le 25 ]; do echo "  context line $i" >&2; i=$((i + 1)); done
    exit 101
  fi
  # Cargo takes every folder under crates/ for a workspace member, and needs its manifest.
  for member in crates/*/; do
    [ -d "$member" ] || continue
    if [ ! -e "\${member}Cargo.toml" ]; then
      echo "error: failed to load manifest for workspace member $member" >&2
      exit 101
    fi
  done
  folder=""
  previous=""
  for arg in "$@"; do
    [ "$previous" = --profile ] && folder="$arg"
    previous="$arg"
  done
  [ "$folder" = dev ] && folder=debug
  mkdir -p "$CARGO_TARGET_DIR/$folder"
  names=""
  previous=""
  for arg in "$@"; do
    [ "$previous" = --bin ] && names="$names $arg"
    previous="$arg"
  done
  for name in $names; do
    main="crates/$name/src/main.rs"
    bin="$CARGO_TARGET_DIR/$folder/$name"
    printf '#!/bin/sh\\necho "BUILT FROM: %s"\\n' "$(cat "$main")" > "$bin"
    chmod +x "$bin"
    if [ "\${STUB_RELATIVE_DEPINFO:-}" = 1 ]; then
      printf '%s: %s\\n' "$bin" "$main" > "$bin.d"
    elif [ "\${STUB_NO_DEPINFO:-}" != 1 ]; then
      printf '%s: %s/%s\\n' "$bin" "$(pwd)" "$main" > "$bin.d"
    fi
  done
  exit 0
fi
[ "$1" = metadata ] || exit 1
[ "\${STUB_FAIL_METADATA:-}" = 1 ] && exit 101
printf '{"packages":['
sep=""
for manifest in crates/*/Cargo.toml; do
  [ -e "$manifest" ] || continue
  crate="\${manifest#crates/}"
  crate="\${crate%%/*}"
  kind=lib
  [ -e "crates/$crate/src/main.rs" ] && kind=bin
  printf '%s{"name":"%s","targets":[{"name":"%s","kind":["%s"]}]}' "$sep" "$crate" "$crate" "$kind"
  sep=","
done
printf ']}'
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
    BZ_FALSIFY_UNCONTAINED: "1",
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
  write(root, "bin/cargo", STUB_CARGO);
  chmodSync(join(root, "bin/cargo"), 0o755);
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

/** Rewrites the branch's commit so its test file has the base's test `v` as `call` instead. */
function renameTest(call: string, trailer?: string): void {
  write(fx.linked, TEST, `import { v } from "./x.ts";\n${call}\n`);
  git(fx.linked, "add", TEST);
  const message = trailer === undefined ? [] : ["-m", trailer];
  git(fx.linked, "commit", "--quiet", "--amend", "-m", "feat: v2", ...message);
}

const IMPORTS = 'import { v } from "./x.ts";\n';

const MOVED = "packages/a/src/y.test.ts";
const THIRD = "packages/a/src/z.test.ts";
const RENAMED = `Renamed: ${TEST} › v -> ${TEST} › caps`;
const MOVED_RENAMED = `Renamed: ${TEST} › v -> ${MOVED} › caps`;
const escape = (text: string) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Rewrites the branch's commit so the base's test `v` has left the test file for a new one,
 * MOVED, which holds `moved`.
 */
function moveTest(moved: string, trailer?: string): void {
  write(fx.linked, TEST, IMPORTS);
  write(fx.linked, MOVED, moved);
  git(fx.linked, "add", TEST, MOVED);
  const message = trailer === undefined ? [] : ["-m", trailer];
  git(fx.linked, "commit", "--quiet", "--amend", "-m", "feat: v2", ...message);
}

const lines = (...text: string[]) => `${text.join("\n")}\n`;

/**
 * Remakes the branch on a base whose test file is `base`, with one commit changing the source to
 * `v = 2` and the test file to `head`.
 */
function branchOn(base: string, head: string): void {
  git(fx.linked, "reset", "--quiet", "--hard", fx.base);
  write(fx.linked, TEST, base);
  git(fx.linked, "commit", "--quiet", "-am", "test: base");
  fx.base = git(fx.linked, "rev-parse", "HEAD").trim();
  write(fx.linked, SOURCE, "export const v = 2;\n");
  write(fx.linked, TEST, head);
  git(fx.linked, "commit", "--quiet", "-am", "feat: v2");
}

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
      builtCli: stubLog().includes("BUILD:"),
    }).toEqual({
      status: 0,
      killed: true,
      sawGitVars: false,
      sawOldSource: true,
      sawNewSource: false,
      sawNewTest: true,
      builtCli: false,
    });
  });

  it("leaves the branch's worktree clean and no temporary worktree behind", () => {
    expect(againstBase().status).toBe(0);
    expect({ status: git(fx.linked, "status", "--porcelain"), leftovers: leftovers() }).toEqual({
      status: "",
      leftovers: [],
    });
  });

  it("refuses a falsify the run starts on the repository it is judging, and leaves none behind", () => {
    const result = againstBase({ STUB_NEST: "1", STUB_FALSIFY: FALSIFY, STUB_BASE: fx.base });
    expect({
      status: result.status,
      nested: /falsify run is already judging this repository[\s\S]*NESTED EXIT 2/.test(stubLog()),
      branch: git(fx.linked, "status", "--porcelain"),
      leftovers: leftovers(),
    }).toEqual({ status: 0, nested: true, branch: "", leftovers: [] });
  });

  it("fails when the new test passes without the change", () => {
    expect(againstBase({ STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringContaining("SURVIVED"),
    });
    expect(leftovers()).toEqual([]);
  });

  it("leaves out a test a Renamed trailer names only while its block is the base's", () => {
    renameTest('it("caps", () => {});', RENAMED);
    const renamed = againstBase({ STUB_STATUS: "passed" });
    renameTest('it("caps", () => void v);', RENAMED);
    const rewritten = againstBase({ STUB_STATUS: "passed" });
    expect({ renamed, rewritten }).toEqual({
      renamed: {
        status: 0,
        output: expect.stringContaining(`RENAMED ${TEST} › caps (was ${TEST} › v), not judged`),
      },
      rewritten: {
        status: 1,
        output: expect.stringMatching(
          new RegExp(
            `${escape(RENAMED)} doesn't apply \\(.*"caps" isn't "v" with only its title changed\\)[\\s\\S]*SURVIVED`,
          ),
        ),
      },
    });
  });

  it("judges a test a Renamed trailer names by its titles alone, saying it names no file", () => {
    renameTest('it("caps", () => {});', "Renamed: v -> caps");
    expect(againstBase({ STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringMatching(
        /Renamed: v -> caps doesn't apply \(it names no file[\s\S]*SURVIVED/,
      ),
    });
  });

  it("names the Renamed trailer a surviving test needs when it is the base's under a new title", () => {
    renameTest('it("caps", () => {});');
    expect(againstBase({ STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringMatching(new RegExp(`SURVIVED[\\s\\S]*\\n  ${escape(RENAMED)}\\n`)),
    });
  });

  it("leaves out a test a Renamed trailer moves to another file only while its block is the base's", () => {
    moveTest(`${IMPORTS}it("caps", () => {});\n`, MOVED_RENAMED);
    const moved = againstBase({ STUB_STATUS: "passed", STUB_TEST: MOVED });
    moveTest(`${IMPORTS}it("caps", () => void v);\n`, MOVED_RENAMED);
    const rewritten = againstBase({ STUB_STATUS: "passed", STUB_TEST: MOVED });
    expect({ moved, rewritten }).toEqual({
      moved: {
        status: 0,
        output: expect.stringContaining(`RENAMED ${MOVED} › caps (was ${TEST} › v), not judged`),
      },
      rewritten: {
        status: 1,
        output: expect.stringMatching(
          new RegExp(
            `${escape(MOVED_RENAMED)} doesn't apply \\([\\s\\S]*SURVIVED ${escape(MOVED)} › caps`,
          ),
        ),
      },
    });
  });

  it("names the Renamed trailer an INVALID test needs, not a control, when it is a base test moved from another file", () => {
    moveTest('it("caps", () => {});\n');
    const result = againstBase({ STUB_STATUS: "passed", STUB_TEST: MOVED });
    expect({ ...result, asksControl: result.output.includes(`Control: ${MOVED} › caps:`) }).toEqual(
      {
        status: 1,
        output: expect.stringMatching(
          new RegExp(`INVALID  ${escape(MOVED)} › caps[\\s\\S]*\\n  ${escape(MOVED_RENAMED)}\\n`),
        ),
        asksControl: false,
      },
    );
  });

  it("leaves out a test renamed in a test file git sees as renamed, named by both its paths", () => {
    const kept = lines(
      'it("keeps", () => {',
      "  expect(v).toBe(1);",
      "  expect(v).not.toBe(0);",
      "});",
    );
    branchOn(IMPORTS + kept + 'it("v", () => {});\n', IMPORTS + kept + 'it("v", () => {});\n');
    git(fx.linked, "mv", TEST, MOVED);
    write(fx.linked, MOVED, IMPORTS + kept + 'it("caps", () => {});\n');
    git(fx.linked, "add", MOVED);
    git(fx.linked, "commit", "--quiet", "--amend", "-m", "feat: v2", "-m", MOVED_RENAMED);
    expect(git(fx.linked, "diff", "--name-status", "-M", fx.base)).toMatch(/^R\d+\t/m);
    const renamed = againstBase({ STUB_STATUS: "passed", STUB_TEST: MOVED });
    write(fx.linked, MOVED, IMPORTS + kept + 'it("v", () => {});\nit("caps", () => {});\n');
    git(fx.linked, "commit", "--quiet", "--amend", "-am", "feat: v2", "-m", MOVED_RENAMED);
    expect(git(fx.linked, "diff", "--name-status", "-M", fx.base)).toMatch(/^R\d+\t/m);
    expect({ renamed, copied: againstBase({ STUB_STATUS: "passed", STUB_TEST: MOVED }) }).toEqual({
      renamed: {
        status: 0,
        output: expect.stringContaining(`RENAMED ${MOVED} › caps (was ${TEST} › v), not judged`),
      },
      copied: {
        status: 1,
        output: expect.stringContaining(`HEAD still has a test "v" in ${MOVED}`),
      },
    });
  });

  it("judges both copies when two trailers move one base test into two files", () => {
    moveTest(`${IMPORTS}it("caps", () => {});\n`);
    write(fx.linked, THIRD, `${IMPORTS}it("caps", () => {});\n`);
    git(fx.linked, "add", THIRD);
    const toThird = `Renamed: ${TEST} › v -> ${THIRD} › caps`;
    git(
      fx.linked,
      "commit",
      "--quiet",
      "--amend",
      "-m",
      "feat: v2",
      "-m",
      MOVED_RENAMED,
      "-m",
      toThird,
    );
    const twice = `${escape(TEST)} › v is named the old test of more than one test`;
    expect(againstBase({ STUB_STATUS: "passed", STUB_EACH: "1" })).toEqual({
      status: 1,
      output: expect.stringMatching(
        new RegExp(
          `${escape(MOVED_RENAMED)} doesn't apply \\(${twice}\\)[\\s\\S]*` +
            `${escape(toThird)} doesn't apply \\(${twice}\\)[\\s\\S]*` +
            `SURVIVED ${escape(MOVED)} › caps[\\s\\S]*SURVIVED ${escape(THIRD)} › caps`,
        ),
      ),
    });
  });

  it("judges a test moved out of a file named by another spelling of its path", () => {
    const kept = lines(
      'it("keeps", () => {',
      "  expect(v).toBe(1);",
      "  expect(v).not.toBe(0);",
      "});",
    );
    branchOn(IMPORTS + kept + 'it("v", () => {});\n', IMPORTS + kept + 'it("v", () => {});\n');
    git(fx.linked, "mv", TEST, MOVED);
    write(fx.linked, THIRD, `${IMPORTS}it("v", () => {});\n`);
    git(fx.linked, "add", THIRD);
    const aliased = `Renamed: ./${TEST} › v -> ${THIRD} › v`;
    git(fx.linked, "commit", "--quiet", "--amend", "-m", "feat: v2", "-m", aliased);
    expect(git(fx.linked, "diff", "--name-status", "-M", fx.base)).toMatch(/^R\d+\t/m);
    expect(againstBase({ STUB_STATUS: "passed", STUB_TEST: THIRD })).toEqual({
      status: 1,
      output: expect.stringMatching(
        new RegExp(
          `${escape(aliased)} doesn't apply \\(\\./${escape(TEST)} isn't the base path of a .test.ts file the branch changed\\)`,
        ),
      ),
    });
  });

  it("judges a test moved out of a .tsx test file, whose tests falsify can't read", () => {
    const tsx = "packages/a/src/w.test.tsx";
    const view = lines("const a = <p>{v}</p>;", "const b = <b>{v}</b>;", "const c = <i>{v}</i>;");
    git(fx.linked, "reset", "--quiet", "--hard", fx.base);
    write(fx.linked, tsx, `${IMPORTS}${view}it("caps", () => {});\n`);
    git(fx.linked, "add", tsx);
    git(fx.linked, "commit", "--quiet", "-m", "test: base");
    fx.base = git(fx.linked, "rev-parse", "HEAD").trim();
    git(fx.linked, "rm", "--quiet", tsx);
    write(fx.linked, SOURCE, "export const v = 2;\n");
    write(fx.linked, MOVED, `${IMPORTS}it("caps", () => {});\n`);
    git(fx.linked, "add", SOURCE, MOVED);
    const fromTsx = `Renamed: ${tsx} › caps -> ${MOVED} › caps`;
    git(fx.linked, "commit", "--quiet", "-m", "feat: v2", "-m", fromTsx);
    expect(git(fx.linked, "diff", "--name-status", "-M", fx.base)).toMatch(/^D\t.*w\.test\.tsx$/m);
    expect(againstBase({ STUB_STATUS: "passed", STUB_TEST: MOVED })).toEqual({
      status: 1,
      output: expect.stringContaining(
        `${fromTsx} doesn't apply (${tsx} isn't the base path of a .test.ts file the branch changed)`,
      ),
    });
  });

  it("judges a test added to a .tsx test file git renamed to .ts, whose base JSX fakes its call", () => {
    const tsx = "packages/a/src/w.test.tsx";
    const ts = "packages/a/src/w.test.ts";
    const shared = lines(
      "const a = v + 1;",
      "const b = v + 2;",
      "const c = v + 3;",
      "const d = v + 4;",
      "const e = v + 5;",
      "const f = v + 6;",
      "const g = v + 7;",
      "const h = v + 8;",
    );
    git(fx.linked, "reset", "--quiet", "--hard", fx.base);
    write(
      fx.linked,
      tsx,
      `${IMPORTS}${shared}it("renders", () => {\n  render(<p>it("caps", () => {})</p>, <b>x</b>);\n});\n`,
    );
    git(fx.linked, "add", tsx);
    git(fx.linked, "commit", "--quiet", "-m", "test: base");
    fx.base = git(fx.linked, "rev-parse", "HEAD").trim();
    git(fx.linked, "mv", tsx, ts);
    write(fx.linked, ts, `${IMPORTS}${shared}it("renders", () => {});\nit("caps", () => {});\n`);
    write(fx.linked, SOURCE, "export const v = 2;\n");
    git(fx.linked, "add", SOURCE, ts);
    git(fx.linked, "commit", "--quiet", "-m", "feat: v2");
    expect(git(fx.linked, "diff", "--name-status", "-M", fx.base)).toMatch(
      /^R\d+\t.*w\.test\.tsx\t.*w\.test\.ts$/m,
    );
    expect(againstBase({ STUB_STATUS: "passed", STUB_TEST: ts })).toEqual({
      status: 1,
      output: expect.stringContaining(
        `falsify: ${ts}: falsify reads tests only from .ts, .mts and .cts files, and its base copy is ${tsx}, so its new tests count`,
      ),
    });
  });

  it("judges only the test a branch adds, not an unchanged one the diff reads as removed and added", () => {
    const moved = lines('it("v", () => {', "  expect(v).toBe(1);", "});");
    const block = lines(
      'describe("block", () => {',
      '  it("stays", () => {',
      "    expect(v).toBe(1);",
      "    expect(v).not.toBe(2);",
      "  });",
      "});",
    );
    branchOn(IMPORTS + block + moved, IMPORTS + moved + block + 'it("caps", () => {});\n');
    expect(git(fx.linked, "diff", fx.base, "--", TEST)).toMatch(/^\+it\("v"/m);
    expect(againstBase()).toEqual({
      status: 0,
      output: expect.not.stringMatching(/› (?:v|stays)\b/),
    });
  });

  it("reads the title of a chained test call that the formatter wrapped onto its next line", () => {
    renameTest(lines('it("v", () => {});', "it.runIf(true)(", '  "caps",', "  () => {},", ");"));
    expect(againstBase()).toEqual({
      status: 0,
      output: expect.stringContaining(`KILLED   ${TEST} › caps`),
    });
  });

  it("fails on an INVALID test until a commit on the branch holds a control whose break fails it", () => {
    const before = againstBase(CONTROLLABLE);
    const bare = guardCommit([], [CONTROL]);
    const unbroken = againstBase(CONTROLLABLE);
    git(fx.linked, "reset", "--quiet", "--hard", "HEAD~1");
    const commit = guardCommit([breakOf()], [CONTROL]);
    git(fx.linked, "commit", "--quiet", "--allow-empty", "-m", "chore: later");
    const after = againstBase(CONTROLLABLE);
    expect({
      before: { status: before.status, asks: before.output.includes(`\n${ASKS_CONTROL}\n`) },
      unbroken: {
        status: unbroken.status,
        why: unbroken.output.includes(
          `(its control doesn't hold: commit ${bare} holds no \`\`\`diff block)`,
        ),
      },
      after: {
        status: after.status,
        controlled: after.output.includes(`  CONTROLLED ${TEST} › caps\n`),
        under: after.output.includes(
          `under the break in ${commit}: AssertionError: expected 2 to be 3`,
        ),
      },
      leftovers: leftovers(),
    }).toEqual({
      before: { status: 1, asks: true },
      unbroken: { status: 1, why: true },
      after: { status: 0, controlled: true, under: true },
      leftovers: [],
    });
  });

  it("asks a literal title of a test whose title it couldn't read, whatever controls name", () => {
    renameTest(branchTest(`${UNREADABLE}\n`), CONTROL);
    expect(againstBase()).toEqual({
      status: 1,
      output: expect.stringContaining(`Give each test a literal title:\n  ${TEST}\n`),
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

  it("prints the end of what each failed install attempt said", () => {
    const result = againstBase({ STUB_FAIL_INSTALL: "1" });
    expect({
      status: result.status,
      offlineEnd: result.output.includes("pnpm --offline line 25"),
      onlineEnd: result.output.includes("pnpm --prefer-offline line 25"),
      offlineStart: result.output.includes("pnpm --offline line 1\n"),
    }).toEqual({ status: 1, offlineEnd: true, onlineEnd: true, offlineStart: false });
  });

  it("runs the dependencies' builds the install ignored before any test, so a passing test survives", () => {
    const result = againstBase({ STUB_STATUS: "passed" });
    expect({
      result,
      steps: stubLog().match(/^(?:ARGS: (?:install|rebuild)\b|VITEST:)/gm),
    }).toEqual({
      result: { status: 1, output: expect.stringContaining(`SURVIVED ${TEST} › caps`) },
      steps: ["ARGS: install", "ARGS: rebuild", "VITEST:"],
    });
  });

  it("judges nothing, naming allowBuilds and what pnpm said, when the dependencies' builds fail", () => {
    const result = againstBase({ STUB_FAIL_REBUILD: "1" });
    expect({
      status: result.status,
      said: result.output.includes("Ignored build scripts: stub-dep@1.0.0"),
      named: /`pnpm rebuild`[^\n]*allowBuilds/.test(result.output),
      toldToInstall: result.output.includes("run `pnpm install`"),
      judged: /KILLED|SURVIVED|INVALID/.test(result.output),
      ranTests: stubLog().includes("VITEST:"),
      leftovers: leftovers(),
    }).toEqual({
      status: 1,
      said: true,
      named: true,
      toldToInstall: false,
      judged: false,
      ranTests: false,
      leftovers: [],
    });
  });

  it("prints under a failed test the first line of what failed it", () => {
    const result = againstBase({
      STUB_FAILURE: "AssertionError: expected 1 to be 2\\n    at x.test.ts:3",
    });
    expect(result).toEqual({
      status: 0,
      output: expect.stringContaining(
        `KILLED   ${TEST} › caps\n           failed: AssertionError: expected 1 to be 2\n`,
      ),
    });
  });

  it("says a vitest run stopped at falsify's cap left no report, and what it printed", () => {
    const result = againstBase({ STUB_HANG_VITEST: "1", FALSIFY_VITEST_TIMEOUT_MS: "1000" });
    const why = "it timed out after 1 s, falsify's cap on one vitest run";
    expect({
      status: result.status,
      block: result.output.includes(
        `falsify: the unit run (1 file) left no report: ${why}. The end of what it printed:\n` +
          "  stub vitest: still running\n",
      ),
      line: result.output.includes(`INVALID  ${TEST} › caps (no report from the unit run: ${why})`),
      asks: result.output.includes(ASKS_CONTROL),
      leftovers: leftovers(),
    }).toEqual({ status: 1, block: true, line: true, asks: true, leftovers: [] });
  }, 30_000);

  it("judges the tests a run stopped at the cap finished, from the reporter beside falsify", () => {
    write(
      fx.linked,
      TEST,
      'import { v } from "./x.ts";\nit("v", () => {});\nit("caps", () => {});\nit("hangs", () => {});\n',
    );
    git(fx.linked, "add", TEST);
    git(fx.linked, "commit", "--quiet", "--amend", "-m", "feat: v2");
    const result = againstBase({
      STUB_HANG_VITEST: "1",
      STUB_RECORD: "1",
      FALSIFY_VITEST_TIMEOUT_MS: "1000",
    });
    const why = "it timed out after 1 s, falsify's cap on one vitest run";
    expect({
      status: result.status,
      block: result.output.includes(
        `falsify: the unit run (1 file) left no report: ${why}. 1 of the 2 tests it collected ` +
          "finished, and are judged from what falsify's reporter recorded as each ended. The " +
          "end of what it printed:\n",
      ),
      finished: result.output.includes(
        `KILLED   ${TEST} › caps\n           failed: AssertionError: expected 1 to be 2\n`,
      ),
      unfinished: result.output.includes(
        `INVALID  ${TEST} › hangs (no report from the unit run: ${why})`,
      ),
      asks: [...result.output.matchAll(/^ {2}Control: .*$/gm)].map((m) => m[0]),
      reporter: stubLog().includes(`--reporter=${REPORTER} --reporter=json`),
      leftovers: leftovers(),
    }).toEqual({
      status: 1,
      block: true,
      finished: true,
      unfinished: true,
      asks: [`  Control: ${TEST} › hangs: <what you broke> -> <how it failed>`],
      reporter: true,
      leftovers: [],
    });
  }, 30_000);

  it("says a vitest run exited with a code and no report, with the end of what it printed", () => {
    const result = againstBase({ STUB_VITEST_EXIT: "2" });
    expect({
      status: result.status,
      block: result.output.includes(
        "falsify: the unit run (1 file) left no report: it exited with code 2. The end of what " +
          "it printed:\n  stub vitest line 8\n",
      ),
      end: result.output.includes(
        "  stub vitest line 25\n  stub vitest: 1 project failed to start\n" +
          "  Error: global setup failed\n",
      ),
      start: result.output.includes("stub vitest line 7\n"),
      line: result.output.includes(
        `INVALID  ${TEST} › caps (no report from the unit run: it exited with code 2)`,
      ),
      asks: result.output.includes(ASKS_CONTROL),
    }).toEqual({ status: 1, block: true, end: true, start: false, line: true, asks: true });
  });

  it.each([
    ["none", "it wrote no report", "  stub vitest: done"],
    ["garbage", "its report isn't JSON", "  (nothing)"],
    ["wrong", "its report isn't a vitest report", "  (nothing)"],
    ["dir", "its report couldn't be read (EISDIR)", "  (nothing)"],
  ])("says why a vitest run that exited 0 left no usable report (%s)", (mode, why, said) => {
    const result = againstBase({ STUB_VITEST_REPORT: mode });
    expect({
      status: result.status,
      block: result.output.includes(
        `falsify: the unit run (1 file) left no report: ${why}. The end of what it printed:\n` +
          `${said}\n`,
      ),
      line: result.output.includes(`INVALID  ${TEST} › caps (no report from the unit run: ${why})`),
      asks: result.output.includes(ASKS_CONTROL),
    }).toEqual({ status: 1, block: true, line: true, asks: true });
  });

  it("keeps a verdict another project's report gives a file off its no-report run's line", () => {
    const result = againstBase({ STUB_ALSO_PROJECT: "medium" });
    expect({
      status: result.status,
      block: result.output.includes("falsify: the medium run (1 file) left no report"),
      line: result.output.includes(`KILLED   ${TEST} › caps\n`),
    }).toEqual({ status: 0, block: true, line: true });
  });

  it("keeps a test of a run that left no report INVALID under a control, as HEAD's run leaves none", () => {
    const before = againstBase({ STUB_VITEST_REPORT: "none" });
    guardCommit([breakOf()], [CONTROL]);
    const after = againstBase({ STUB_VITEST_REPORT: "none" });
    expect({
      before: before.status,
      named: before.output.includes(`${ASKS_CONTROL}\n`),
      why: before.output.includes("(no report from the unit run: it wrote no report)"),
      after: after.status,
      unheld: after.output.includes("(its control doesn't hold: it doesn't pass at HEAD"),
    }).toEqual({ before: 1, named: true, why: true, after: 1, unheld: true });
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

const SCRIPT = "scripts/x.ts";

/**
 * Commits `source` as the base has it on the branch, then a change to it with `test`, and runs
 * falsify against that first commit.
 */
function changeScript(
  source: string,
  test: { path: string; text: string },
  extra: Record<string, string> = {},
) {
  write(fx.linked, source, "export const s = 1;\n");
  git(fx.linked, "add", source);
  git(fx.linked, "commit", "--quiet", "-m", "feat: s1");
  const base = git(fx.linked, "rev-parse", "HEAD").trim();
  write(fx.linked, source, "export const s = 2;\n");
  write(fx.linked, test.path, test.text);
  git(fx.linked, "add", source, test.path);
  git(fx.linked, "commit", "--quiet", "-m", "feat: s2");
  return falsify(["--base", base], { STUB_SOURCE: source, STUB_TEST: test.path, ...extra });
}

/** `head`, then the `caps` test the branch adds to packages/a, which the stub reports. */
const branchTest = (head: string) => {
  const caps = readFileSync(join(fx.linked, TEST), "utf8")
    .split("\n")
    .filter((line) => line.includes('"caps"'));
  return `${head}${caps.join("\n")}\n`;
};

const scriptTest = () => ({
  path: "scripts/x.test.ts",
  text: branchTest('import { s } from "./x.ts";\n'),
});

/**
 * Commits a generator's `source` and its committed `output` on the branch, then a change to both
 * with `test`, and runs falsify against the first commit with the stub showing the output.
 */
function changeGenerated(source: string, output: string, test: { path: string; text: string }) {
  write(fx.linked, source, "export const g = 1;\n");
  write(fx.linked, output, '{"generated":1}\n');
  git(fx.linked, "add", source, output);
  git(fx.linked, "commit", "--quiet", "-m", "feat: g1");
  const base = git(fx.linked, "rev-parse", "HEAD").trim();
  write(fx.linked, source, "export const g = 2;\n");
  write(fx.linked, output, '{"generated":2}\n');
  write(fx.linked, test.path, test.text);
  git(fx.linked, "add", source, output, test.path);
  git(fx.linked, "commit", "--quiet", "-m", "feat: g2");
  return falsify(["--base", base], { STUB_SOURCE: output, STUB_TEST: test.path });
}

const sawBaseOutput = () => stubLog().includes('SOURCE: {"generated":1}');

describe("falsify on a branch that changes a script", () => {
  it("runs the script's new test against the base's script", () => {
    const result = changeScript(SCRIPT, scriptTest());
    expect({
      status: result.status,
      killed: result.output.includes("KILLED   scripts/x.test.ts › caps"),
      sawOldScript: stubLog().includes("SOURCE: export const s = 1;"),
    }).toEqual({ status: 0, killed: true, sawOldScript: true });
  });

  it("fails when the script's new test passes without the change", () => {
    expect(changeScript(SCRIPT, scriptTest(), { STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringContaining("SURVIVED scripts/x.test.ts › caps"),
    });
  });

  it("asks a control for a passing test that imports no script the branch changed, and refuses one breaking a script it doesn't import", () => {
    const unrelated = { path: "scripts/y.test.ts", text: branchTest("") };
    const before = changeScript(SCRIPT, unrelated, { STUB_STATUS: "passed" });
    const base = git(fx.linked, "rev-parse", "HEAD~1").trim();
    const naming = `Control: ${unrelated.path} › caps: return s = 1 -> expected 2, got 1`;
    const commit = guardCommit([breakOf({ file: SCRIPT, from: "export const s = 2;" })], [naming]);
    const after = falsify(["--base", base], {
      STUB_SOURCE: SCRIPT,
      STUB_TEST: unrelated.path,
      STUB_STATUS: "passed",
    });
    expect({
      before,
      after: after.status,
      refused: after.output.includes(
        `(its control doesn't hold: the break in ${commit}: ${SCRIPT} isn't source the test imports)`,
      ),
    }).toEqual({
      before: {
        status: 1,
        output: expect.stringContaining("(passed; unrelated to the source change)"),
      },
      after: 1,
      refused: true,
    });
  });

  it("reverts a generator's committed output with it, so a test reading the output sees the base's", () => {
    const test = "scripts/lint-config.medium.test.ts";
    const result = changeGenerated("scripts/lint-config.ts", ".oxlintrc.json", {
      path: test,
      text: branchTest('import { g } from "./lint-config.ts";\n'),
    });
    expect({
      status: result.status,
      killed: result.output.includes(`KILLED   ${test} › caps`),
      sawBaseOutput: sawBaseOutput(),
    }).toEqual({ status: 0, killed: true, sawBaseOutput: true });
  });

  it("reverts the holder fixtures with the protocol source they are generated from", () => {
    const test = "packages/protocol/src/holder.test.ts";
    const result = changeGenerated(
      "packages/protocol/src/holder.ts",
      "packages/protocol/fixtures/holder/1.0/frames.json",
      { path: test, text: branchTest('import { g } from "./holder.ts";\n') },
    );
    expect({
      status: result.status,
      killed: result.output.includes(`KILLED   ${test} › caps`),
      sawBaseOutput: sawBaseOutput(),
    }).toEqual({ status: 0, killed: true, sawBaseOutput: true });
  });

  it("judges a change to falsify.ts by reverting it, so a test that only runs it can survive", () => {
    const runsIt = {
      path: "scripts/falsify.medium.test.ts",
      text: branchTest('const FALSIFY = fileURLToPath(new URL("falsify.ts", import.meta.url));\n'),
    };
    const result = changeScript("scripts/falsify.ts", runsIt, { STUB_STATUS: "passed" });
    expect({ result, sawOldHarness: stubLog().includes("SOURCE: export const s = 1;") }).toEqual({
      result: {
        status: 1,
        output: expect.stringContaining("SURVIVED scripts/falsify.medium.test.ts › caps"),
      },
      sawOldHarness: true,
    });
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
      "--amend",
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

  it.runIf(inCappedScope)(
    "stops what a mutant's run started in a session of its own once that run ends",
    async () => {
      mutatedBranch(
        ["tests::b_is_two"],
        [mutantOfB("replace b -> u8 with 0")],
        [`MUTATED|tests::b_is_two|${ASSERTION}`],
      );
      const result = againstBase({ ...CONTAINED, STUB_SESSION: "30" });
      const session = Number(/^SESSION (\d+)$/m.exec(stubLog())?.[1]);
      expect({ status: result.status, started: session > 1 }).toEqual({ status: 0, started: true });
      // Stopped, though perhaps not yet reaped.
      await expect.poll(() => isAlive(session), { timeout: 2000 }).toBe(false);
    },
    CONTAINED_TIMEOUT_MS,
  );

  it.runIf(inCappedScope)(
    "fails on what a run without a mutant left running, naming the run's tests",
    async () => {
      mutatedBranch(
        ["tests::b_is_two"],
        [mutantOfB("replace b -> u8 with 0")],
        [`MUTATED|tests::b_is_two|${ASSERTION}`],
      );
      const result = againstBase({ ...CONTAINED, STUB_SESSION_UNMUTATED: "30" });
      const sessions = [...stubLog().matchAll(/^SESSION (\d+)$/gm)].map(([, pid]) => Number(pid));
      expect({
        status: result.status,
        leaks: result.output.match(/^ {2}the \w+ run of .* left .* running$/gm),
        sessions: sessions.length,
      }).toEqual({
        status: 1,
        leaks: [
          "  the unmutated run of hook tests::b_is_two left sleep ×1 running",
          "  the recheck run of hook tests::b_is_two left sleep ×1 running",
        ],
        sessions: 2,
      });
      await expect.poll(() => sessions.some((pid) => isAlive(pid)), { timeout: 2000 }).toBe(false);
    },
    CONTAINED_TIMEOUT_MS,
  );

  it.runIf(inCappedScope)(
    "only logs what a run without a mutant left running when a test of it was ended at its time limit",
    async () => {
      mutatedBranch(["tests::b_is_two"], [mutantOfB("replace b -> u8 with 0")]);
      const result = againstBase({
        ...CONTAINED,
        STUB_SESSION_UNMUTATED: "30",
        STUB_SLOW_UNMUTATED: "tests::b_is_two",
      });
      const session = Number(/^SESSION (\d+)$/m.exec(stubLog())?.[1]);
      expect({
        started: session > 1,
        logged: result.output.includes(
          "falsify: the unmutated run of hook tests::b_is_two left sleep ×1 running, stopped with " +
            "it, after a test was ended at its time limit",
        ),
        failsOnIt: result.output.includes("left processes running"),
        invalid: result.output.includes("tests::b_is_two (Rust: fails or doesn't run unmutated"),
      }).toEqual({ started: true, logged: true, failsOnIt: false, invalid: true });
      await expect.poll(() => isAlive(session), { timeout: 2000 }).toBe(false);
    },
    CONTAINED_TIMEOUT_MS,
  );

  it("says a mutant's run timed out, and judges the test by the others", () => {
    mutatedBranch(["tests::b_is_two"], [mutantOfB("replace b -> u8 with 0")]);
    const result = againstBase({ ...CONTAINED, STUB_HANG: "1", FALSIFY_RUST_TIMEOUT_MS: "2000" });
    expect({
      status: result.status,
      timedOut: result.output.includes(
        `INVALID  mutant ${LIB}:5:5: replace b -> u8 with 0 (its run timed out after 2 s)`,
      ),
      asks: result.output.includes("Control: tests::b_is_two:"),
      progress: /^falsify: mutant 1 of .* in \d+ s \(timed out\): /m.test(result.output),
    }).toEqual({ status: 1, timedOut: true, asks: true, progress: true });
  }, 20_000);

  it("says as it goes that a mutant's run had a test process killed at the memory cap", () => {
    mutatedBranch(["tests::b_is_two"], [mutantOfB("replace b -> u8 with 0")]);
    const result = againstBase({ STUB_MEMORY_KILL: "1" });
    expect(result.output.match(/^falsify: mutant 1 of .*$/gm)).toEqual([
      expect.stringMatching(/ in \d+ s \(memory-killed\): .*replace b -> u8 with 0$/),
    ]);
  });

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

  it("says as it goes how long each mutant it ran took, against how many tests and killing how many", () => {
    mutatedBranch(
      ["tests::b_is_two", "tests::b_is_not_one", "tests::b_is_broken"],
      [
        mutantOfB("stale context", "    3", "    0 /* MUTATED */"),
        mutantOfB("replace b -> u8 with 0"),
        mutantOfB("replace b -> u8 with 1", "    2", "    1 /* MUTATED ONE */"),
      ],
      [
        `MUTATED|tests::b_is_two|${ASSERTION}`,
        `MUTATED ONE|tests::b_is_not_one|${ASSERTION}`,
        `fn b|tests::b_is_broken|${ASSERTION}`,
      ],
    );
    const result = againstBase();
    expect({
      status: result.status,
      unmutated: /^falsify: 3 new Rust tests run unmutated in \d+ s, 2 passing$/m.test(
        result.output,
      ),
      mutants: result.output
        .match(/^falsify: mutant \d+ of .*$/gm)
        ?.map((l) => l.replace(/ in \d+ s/, "")),
    }).toEqual({
      status: 1,
      unmutated: true,
      mutants: [
        `falsify: mutant 1 of at most 100 (3 listed), against 2 tests, killed 1: ${LIB}:5:5: replace b -> u8 with 0`,
        `falsify: mutant 2 of at most 100 (3 listed), against 1 test, killed 1: ${LIB}:5:5: replace b -> u8 with 1`,
      ],
    });
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
      hint: result.output.includes(installCommand("cargo-mutants")),
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
        env: env({ ...CONTAINED, STUB_HANG: "1" }),
        stdio: "ignore",
      });
      const exited = once(child, "exit");
      await expect.poll(() => stubLog().includes("HANGING"), { timeout: 20_000 }).toBe(true);
      const nextest = Number(/^HANGING (\d+)$/m.exec(stubLog())?.[1]);
      signalOwnChild(child, signal);
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
      signalOwnChild(child, "SIGINT");
      await expect.poll(() => stubLog().includes("TERMED"), { timeout: 5000 }).toBe(true);
      // Still waiting out the grace, so the second Ctrl-C lands while it stops.
      expect({ exitCode: child.exitCode, signalCode: child.signalCode }).toEqual({
        exitCode: null,
        signalCode: null,
      });
      signalOwnChild(child, "SIGINT");
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

/** A branch commit whose source sends a signal through the TypeScript chokepoint. */
const signallingSource = () => {
  write(
    fx.linked,
    SOURCE,
    'import { signalGroup } from "@bazhen/host-guard";\nexport const v = 2;\n' +
      'export const stop = (c) => signalGroup(c, "SIGTERM");\n',
  );
  git(fx.linked, "add", SOURCE);
  git(fx.linked, "commit", "--quiet", "-m", "feat: stop");
};

describe("falsify outside a sandbox", () => {
  const AS_HOST = { BZ_FALSIFY_AS_HOST: "1" };

  it("refuses to revert source that signals processes, before it makes a worktree", () => {
    signallingSource();
    // A worktree made before the refusal would fail here, on a folder it can't write to.
    chmodSync(fx.tmp, 0o500);
    let result: ReturnType<typeof againstBase>;
    try {
      result = againstBase(AS_HOST);
    } finally {
      chmodSync(fx.tmp, 0o700);
    }
    expect({
      status: result.status,
      named: result.output.includes(`  ${SOURCE}`),
      pointsAt: result.output.includes("moon run :test-real -- falsify"),
      crashed: /EACCES|permission denied/i.test(result.output),
      installed: stubLog().includes("ARGS: install"),
      leftovers: leftovers(),
    }).toEqual({
      status: 1,
      named: true,
      pointsAt: true,
      crashed: false,
      installed: false,
      leftovers: [],
    });
  });

  it("refuses a branch whose TypeScript signals before its Rust tests run", () => {
    signallingSource();
    mutatedBranch(
      ["tests::b_is_two"],
      [mutantOfB("replace b -> u8 with 0")],
      [`MUTATED|tests::b_is_two|${ASSERTION}`],
    );
    const result = againstBase(AS_HOST);
    expect({
      status: result.status,
      named: result.output.includes(`  ${SOURCE}`),
      nextest: stubLog().includes("NEXTEST:"),
    }).toEqual({ status: 1, named: true, nextest: false });
  });

  it("refuses to mutate Rust that signals processes, before any mutant runs", () => {
    mutatedBranch(
      ["tests::b_is_two"],
      [mutantOfB("replace b -> u8 with 0")],
      [`MUTATED|tests::b_is_two|${ASSERTION}`],
      {
        "crates/x/src/sweep.rs":
          "pub fn sweep(pid: i32) {\n    unsafe { libc::kill(pid, 9) };\n}\n",
      },
    );
    const result = againstBase(AS_HOST);
    expect({
      status: result.status,
      named: result.output.includes("  crates/x/src/sweep.rs"),
      runs: runs(),
      leftovers: leftovers(),
    }).toEqual({ status: 1, named: true, runs: 0, leftovers: [] });
  });

  it("refuses signalling Rust however deep in the repository it is run from", () => {
    mutatedBranch(
      ["tests::b_is_two"],
      [mutantOfB("replace b -> u8 with 0")],
      [`MUTATED|tests::b_is_two|${ASSERTION}`],
      {
        "crates/x/src/sweep.rs":
          "pub fn sweep(pid: i32) {\n    unsafe { libc::kill(pid, 9) };\n}\n",
      },
    );
    const result = spawnSync("node", [FALSIFY, "--base", fx.base], {
      cwd: join(fx.linked, "crates/x/src"),
      env: env(AS_HOST),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect({
      status: result.status,
      named: result.stderr.includes("  crates/x/src/sweep.rs"),
      runs: runs(),
      leftovers: leftovers(),
    }).toEqual({ status: 1, named: true, runs: 0, leftovers: [] });
  });

  it("refuses signalling TypeScript however deep in the repository it is run from", () => {
    signallingSource();
    const result = spawnSync("node", [FALSIFY, "--base", fx.base], {
      cwd: join(fx.linked, "packages/a/src"),
      env: env(AS_HOST),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect({
      status: result.status,
      named: result.stderr.includes(`  ${SOURCE}`),
      installed: stubLog().includes("ARGS: install"),
      leftovers: leftovers(),
    }).toEqual({ status: 1, named: true, installed: false, leftovers: [] });
  });

  it("keeps a relative TMPDIR the caller's, run from a subdirectory", () => {
    const cwd = join(fx.linked, "packages/a/src");
    const result = spawnSync("node", [FALSIFY, "--base", fx.base], {
      cwd,
      env: env({ ...AS_HOST, TMPDIR: relative(cwd, fx.tmp) }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect({
      status: result.status,
      inTmp: stubLog().includes(`PWD: ${fx.tmp}/bz-falsify-`),
    }).toEqual({ status: 0, inTmp: true });
  });

  it("judges the tests ignored as signalling only in a sandbox", () => {
    mutatedBranch(
      ["tests::b_is_two"],
      [mutantOfB("replace b -> u8 with 0")],
      [`MUTATED|tests::b_is_two|${ASSERTION}`],
    );
    expect(againstBase(AS_HOST).status).toBe(0);
    const asHost = stubLog().includes("--run-ignored all");
    writeFileSync(fx.log, "");
    expect(againstBase().status).toBe(0);
    expect({ asHost, here: stubLog().includes("--run-ignored all") }).toEqual({
      asHost: false,
      here: inSignalSandbox(),
    });
  });
});

const CLI_TEST = "tests/cli/x.test.ts";
const OTHER_CRATE = "crates/holder/src/lib.rs";

/**
 * Commits the CLI's crate, another crate and a lockfile on the branch, then a change to `changed`
 * and the files `added` with a new CLI test, and runs falsify against the first commit.
 */
function changeCli(
  changed: string,
  extra: Record<string, string> = {},
  added: Record<string, string> = {},
) {
  const tree: Record<string, string> = {
    [CLI_MAIN]: "fn main() { old }\n",
    "crates/bazhen/Cargo.toml": '[package]\nname = "bazhen"\n',
    [OTHER_CRATE]: "pub fn f() { old }\n",
    "crates/holder/Cargo.toml": '[package]\nname = "holder"\n',
    "Cargo.lock": "version = 4\n",
    "tests/cli/cli.ts": 'export const CLI = join(repo, "target/release/bazhen");\n',
  };
  for (const [path, text] of Object.entries(tree)) write(fx.linked, path, text);
  git(fx.linked, "add", ...Object.keys(tree));
  git(fx.linked, "commit", "--quiet", "-m", "feat: cli1");
  const base = git(fx.linked, "rev-parse", "HEAD").trim();
  write(fx.linked, changed, "fn main() { new }\n");
  for (const [path, text] of Object.entries(added)) write(fx.linked, path, text);
  write(fx.linked, CLI_TEST, branchTest('import { scene } from "./cli.ts";\n'));
  git(fx.linked, "add", changed, ...Object.keys(added), CLI_TEST);
  git(fx.linked, "commit", "--quiet", "-m", "feat: cli2");
  return falsify(["--base", base], { STUB_SOURCE: CLI_MAIN, STUB_TEST: CLI_TEST, ...extra });
}

describe("falsify on a branch with a new CLI test", () => {
  it("runs it against the CLI built from the base's Rust, whatever BAZHEN_CLI the caller set", () => {
    const result = changeCli(CLI_MAIN, { BAZHEN_CLI: "/usr/local/bin/bazhen" });
    const worktree = `${fx.tmp}/bz-falsify-[^/\n]+`;
    expect({
      status: result.status,
      killed: result.output.includes(`KILLED   ${CLI_TEST} › caps`),
      built: new RegExp(
        `^BUILD: build --quiet --locked --profile release -p bazhen --bin bazhen in ${worktree} to ` +
          `${fx.linked}/target/falsify$`,
        "m",
      ).test(stubLog()),
      ran: new RegExp(`^CLI: ${worktree}/target/release/bazhen\n`, "m").test(stubLog()),
      builtFromBase: stubLog().includes("BUILT FROM: fn main() { old }"),
      sawNewSource: stubLog().includes("{ new }"),
    }).toEqual({
      status: 0,
      killed: true,
      built: true,
      ran: true,
      builtFromBase: true,
      sawNewSource: false,
    });
  });

  it("fails when it passes against the base's CLI", () => {
    expect(changeCli(CLI_MAIN, { STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringContaining(`SURVIVED ${CLI_TEST} › caps`),
    });
  });

  it("takes it as unrelated when it passes and the CLI isn't built from the Rust that changed", () => {
    expect(changeCli(OTHER_CRATE, { STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringContaining(
        `INVALID  ${CLI_TEST} › caps (passed; unrelated to the source change)`,
      ),
    });
  });

  it("builds the base's CLI on a branch that adds a crate", () => {
    const result = changeCli(
      CLI_MAIN,
      {},
      { "crates/new/Cargo.toml": '[package]\nname = "new"\n', "crates/new/src/lib.rs": "\n" },
    );
    expect({
      status: result.status,
      killed: result.output.includes(`KILLED   ${CLI_TEST} › caps`),
      builtFromBase: stubLog().includes("BUILT FROM: fn main() { old }"),
    }).toEqual({ status: 0, killed: true, builtFromBase: true });
  });

  it("takes it as unrelated when it passes and only the workspace's lockfile changed", () => {
    expect(changeCli("Cargo.lock", { STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringContaining(
        `INVALID  ${CLI_TEST} › caps (passed; unrelated to the source change)`,
      ),
    });
  });

  it("fails without a verdict when cargo's record names no source in the tree", () => {
    const result = changeCli(CLI_MAIN, { STUB_RELATIVE_DEPINFO: "1", STUB_STATUS: "passed" });
    expect({
      status: result.status,
      said: result.output.includes("names no file under"),
      verdict: /KILLED|SURVIVED|INVALID/.test(result.output),
    }).toEqual({ status: 1, said: true, verdict: false });
  });

  it("fails without a verdict, naming cargo's error, when the base's CLI won't build", () => {
    const result = changeCli(CLI_MAIN, { STUB_FAIL_BUILD: "1" });
    expect({
      status: result.status,
      error: result.output.includes("cargo said:\n  error[E0425]: cannot find value `x`"),
      tail: result.output.includes("  context line 25"),
      verdict: /KILLED|SURVIVED|INVALID/.test(result.output),
      ranTests: stubLog().includes("ARGS: exec"),
      leftovers: leftovers(),
    }).toEqual({
      status: 1,
      error: true,
      tail: true,
      verdict: false,
      ranTests: false,
      leftovers: [],
    });
  });

  it("fails without a verdict when the build leaves no record of what it was built from", () => {
    // The run before leaves its record behind, naming its own worktree.
    expect(changeCli(CLI_MAIN).status).toBe(0);
    const base = git(fx.linked, "rev-parse", "HEAD~1").trim();
    const result = falsify(["--base", base], {
      STUB_SOURCE: CLI_MAIN,
      STUB_TEST: CLI_TEST,
      STUB_NO_DEPINFO: "1",
      STUB_STATUS: "passed",
    });
    expect({
      status: result.status,
      said: result.output.includes("cargo wrote no dep-info"),
      verdict: /KILLED|SURVIVED|INVALID/.test(result.output),
    }).toEqual({ status: 1, said: true, verdict: false });
  });
});

const DAEMON_MAIN = "crates/bazhen-daemon/src/main.rs";
const LISTED_TEST = "tests/api/r.test.ts";
const DAEMON_MANIFEST = {
  "crates/bazhen-daemon/Cargo.toml": '[package]\nname = "bazhen-daemon"\n',
};

/**
 * Commits the Rust daemon's crate (unless `daemonAtBase` is false), another crate, an api helper
 * and the files `atBase`, with `tests/rust-daemon.txt` naming LISTED_TEST (unless `listed` is
 * false), then a change to `changed` and the files `added` with LISTED_TEST's new test, whose
 * head is `imports`, and runs falsify against the first commit.
 */
function changeDaemon(
  changed: string,
  extra: Record<string, string> = {},
  {
    listed = true,
    daemonAtBase = true,
    added = {},
    atBase = {},
    imports = 'import { d } from "./daemon.ts";\n',
    guard,
  }: {
    listed?: boolean;
    daemonAtBase?: boolean;
    added?: Record<string, string>;
    atBase?: Record<string, string>;
    imports?: string;
    /** The message of a commit after the change, holding a guard. */
    guard?: string;
  } = {},
) {
  const tree: Record<string, string> = {
    ...atBase,
    ...(daemonAtBase && { [DAEMON_MAIN]: "fn main() { old daemon }\n", ...DAEMON_MANIFEST }),
    [OTHER_CRATE]: "pub fn f() { old }\n",
    "crates/holder/Cargo.toml": '[package]\nname = "holder"\n',
    "tests/api/daemon.ts": "export const d = 1;\n",
    "tests/rust-daemon.txt": listed ? `# listed\n${LISTED_TEST}\n` : "# none yet\n",
  };
  for (const [path, text] of Object.entries(tree)) write(fx.linked, path, text);
  git(fx.linked, "add", ...Object.keys(tree));
  git(fx.linked, "commit", "--quiet", "-m", "feat: daemon1");
  const base = git(fx.linked, "rev-parse", "HEAD").trim();
  write(fx.linked, changed, "fn main() { new }\n");
  for (const [path, text] of Object.entries(added)) write(fx.linked, path, text);
  write(fx.linked, LISTED_TEST, branchTest(imports));
  git(fx.linked, "add", changed, ...Object.keys(added), LISTED_TEST);
  git(fx.linked, "commit", "--quiet", "-m", "feat: daemon2");
  if (guard !== undefined) {
    git(fx.linked, "commit", "--quiet", "--allow-empty", "--cleanup=verbatim", "-m", guard);
  }
  return falsify(["--base", base], { STUB_SOURCE: DAEMON_MAIN, STUB_TEST: LISTED_TEST, ...extra });
}

// A failure on an assertion in the listed test, and one thrown from a helper it calls.
const ON_ASSERTION = `AssertionError: expected 200 to be 421\\n    at /w/${LISTED_TEST}:3:5`;
const IN_HELPER =
  "Error: the daemon exited before it answered\\n" +
  `    at Daemon.start (/w/tests/api/daemon.ts:9:3)\\n    at /w/${LISTED_TEST}:3:5`;

const ranOnDaemon = () => /^DAEMON: /m.test(stubLog());
const builtDaemon = () =>
  /^BUILD: build --quiet --locked --profile release -p bazhen-daemon --bin bazhen-daemon in /m.test(
    stubLog(),
  );

describe("falsify on a branch with a new test in a file the Rust daemon's list names", () => {
  it("runs it against the Rust daemon built from the base too, and kills it on a failure there", () => {
    const result = changeDaemon(DAEMON_MAIN, {
      STUB_STATUS: "passed",
      STUB_RUST_STATUS: "failed",
      STUB_RUST_FAILURE: ON_ASSERTION,
    });
    const worktree = `${fx.tmp}/bz-falsify-[^/\n]+`;
    expect({
      status: result.status,
      killed: result.output.includes(`KILLED   ${LISTED_TEST} › caps (on the Rust daemon)`),
      built: builtDaemon(),
      ran: new RegExp(
        `^DAEMON: ${worktree}/target/release/bazhen-daemon: BUILT FROM: fn main\\(\\) \\{ old daemon \\}$`,
        "m",
      ).test(stubLog()),
      sawNewSource: stubLog().includes("{ new }"),
      suiteReads: readFileSync(
        fileURLToPath(new URL("../tests/support/test-daemon.ts", import.meta.url)),
        "utf8",
      ).includes(`env["${SELECTOR}"]`),
    }).toEqual({
      status: 0,
      killed: true,
      built: true,
      ran: true,
      sawNewSource: false,
      suiteReads: true,
    });
  });

  it("fails when it passes on the base's Rust daemon, built without the change", () => {
    expect(changeDaemon(DAEMON_MAIN, { STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringContaining(`SURVIVED ${LISTED_TEST} › caps (passed on the Rust daemon)`),
    });
  });

  it("kills it on the TypeScript daemon whatever the Rust daemon does", () => {
    const result = changeDaemon(DAEMON_MAIN, { STUB_STATUS: "failed", STUB_RUST_STATUS: "passed" });
    expect({
      status: result.status,
      killed: new RegExp(`^ {2}KILLED {3}${escape(LISTED_TEST)} › caps$`, "m").test(result.output),
    }).toEqual({ status: 0, killed: true });
  });

  it("runs it on the Rust daemon only when the daemon is built from Rust the branch changed", () => {
    // It would fail there: a run would kill it.
    const other = changeDaemon(OTHER_CRATE, { STUB_STATUS: "passed", STUB_RUST_STATUS: "failed" });
    expect({
      status: other.status,
      unrelated: other.output.includes(
        `INVALID  ${LISTED_TEST} › caps (passed; unrelated to the source change)`,
      ),
      built: builtDaemon(),
      ran: ranOnDaemon(),
    }).toEqual({ status: 1, unrelated: true, built: true, ran: false });
  });

  it("judges it on the TypeScript daemon alone when the daemon's build shows no Rust changed", () => {
    const result = changeDaemon(SOURCE, { STUB_STATUS: "failed", STUB_RUST_STATUS: "passed" });
    expect({
      status: result.status,
      killed: new RegExp(`^ {2}KILLED {3}${escape(LISTED_TEST)} › caps$`, "m").test(result.output),
      built: builtDaemon(),
      ran: ranOnDaemon(),
    }).toEqual({ status: 0, killed: true, built: true, ran: false });
  });

  it("runs it on the Rust daemon when the branch changed a binary the test runs", () => {
    const result = changeDaemon(
      "crates/holder/src/main.rs",
      { STUB_STATUS: "passed", STUB_RUST_STATUS: "failed", STUB_RUST_FAILURE: ON_ASSERTION },
      {
        atBase: { "crates/holder/src/main.rs": "fn main() { old }\n" },
        imports: 'const holder = "target/release/holder";\n',
      },
    );
    expect({
      status: result.status,
      killed: result.output.includes(`KILLED   ${LISTED_TEST} › caps (on the Rust daemon)`),
      ran: ranOnDaemon(),
    }).toEqual({ status: 0, killed: true, ran: true });
  });

  it("runs it on the Rust daemon when the branch changed the workspace's lockfile", () => {
    const result = changeDaemon(
      "Cargo.lock",
      { STUB_STATUS: "passed", STUB_RUST_STATUS: "failed", STUB_RUST_FAILURE: ON_ASSERTION },
      { atBase: { "Cargo.lock": "# old\n" } },
    );
    expect({
      status: result.status,
      killed: result.output.includes(`KILLED   ${LISTED_TEST} › caps (on the Rust daemon)`),
      ran: ranOnDaemon(),
    }).toEqual({ status: 0, killed: true, ran: true });
  });

  it("runs the TypeScript daemon's run without a daemon the caller's environment names", () => {
    const result = changeDaemon(SOURCE, { STUB_STATUS: "failed", [SELECTOR]: "/bin/true" });
    expect({
      status: result.status,
      killed: new RegExp(`^ {2}KILLED {3}${escape(LISTED_TEST)} › caps$`, "m").test(result.output),
      ran: ranOnDaemon(),
    }).toEqual({ status: 0, killed: true, ran: false });
  });

  it.each([
    [
      "a binary the branch adds, which the base doesn't build",
      ON_ASSERTION,
      {
        "crates/spawned/Cargo.toml": '[package]\nname = "spawned"\n',
        "crates/spawned/src/main.rs": "fn main() {}\n",
      },
      "failed on the Rust daemon; the base builds no target/release/spawned",
    ],
    [
      "a throw from a helper",
      IN_HELPER,
      {},
      "failed on the Rust daemon, but not on an assertion in the test",
    ],
  ])(
    "takes a failure on the Rust daemon for no verdict when it may be %s",
    (_, failure, added, why) => {
      const result = changeDaemon(
        DAEMON_MAIN,
        { STUB_STATUS: "passed", STUB_RUST_STATUS: "failed", STUB_RUST_FAILURE: failure },
        { added },
      );
      expect({
        status: result.status,
        invalid: result.output.includes(`INVALID  ${LISTED_TEST} › caps (${why})`),
        ran: ranOnDaemon(),
      }).toEqual({ status: 1, invalid: true, ran: true });
    },
  );

  it("fails without a verdict when the base builds no Rust daemon", () => {
    const result = changeDaemon(
      DAEMON_MAIN,
      { STUB_RUST_STATUS: "failed" },
      { daemonAtBase: false, added: DAEMON_MANIFEST },
    );
    expect({
      status: result.status,
      said: result.output.includes("the base builds no target/release/bazhen-daemon"),
      verdict: /KILLED|SURVIVED|INVALID/.test(result.output),
      ran: ranOnDaemon(),
    }).toEqual({ status: 1, said: true, verdict: false, ran: false });
  });

  it.each([
    ["skips it", { STUB_RUST_STATUS: "skipped" }, "skipped"],
    ["leaves no report", { STUB_RUST_REPORT: "none" }, "it wrote no report"],
    ["doesn't collect it", { STUB_RUST_TITLE: "other" }, "its run has no result for it"],
    ["leaves it unfinished", { STUB_RUST_STATUS: "pending" }, "its run has no result for it"],
  ])("fails without a verdict when the Rust daemon's run %s", (_, extra, reason) => {
    const result = changeDaemon(DAEMON_MAIN, { STUB_STATUS: "passed", ...extra });
    expect({
      status: result.status,
      said: result.output.includes(`${LISTED_TEST} › caps didn't run to an end on the Rust daemon`),
      reason: result.output.includes(reason),
      verdict: /KILLED|SURVIVED|INVALID/.test(result.output),
      ran: ranOnDaemon(),
    }).toEqual({ status: 1, said: true, reason: true, verdict: false, ran: true });
  });
});

describe("falsify on a branch with new tests in two vitest projects", () => {
  it("fails without a verdict when vitest can't name the tests' projects", () => {
    const result = againstBase({ STUB_FAIL_LIST: "1" });
    expect({
      status: result.status,
      said: result.output.includes(
        "couldn't name the projects of the tests to judge (it exited with code 1), so none can " +
          "be judged. The end of what it printed:\n  Error: stub config failed to load\n",
      ),
      verdict: /KILLED|SURVIVED|INVALID/.test(result.output),
      ran: stubLog().includes("VITEST:"),
    }).toEqual({ status: 1, said: true, verdict: false, ran: false });
  });

  it("runs each project's targets in a run of its own, and judges them all", () => {
    const api = "tests/api/y.test.ts";
    write(fx.linked, api, branchTest('import { v } from "../../packages/a/src/x.ts";\n'));
    git(fx.linked, "add", api);
    git(fx.linked, "commit", "--quiet", "-m", "test: api");
    const result = againstBase({ STUB_EACH: "1" });
    expect({
      status: result.status,
      runs: stubLog()
        .match(/^VITEST: .*$/gm)
        ?.map((line) => line.replace(/ --reporter=.*$/, "")),
      killed: [TEST, api].filter((f) => result.output.includes(`KILLED   ${f} › caps`)),
    }).toEqual({
      status: 0,
      runs: [
        `VITEST: exec vitest run --project unit ${TEST}`,
        `VITEST: exec vitest run --project api ${api}`,
      ],
      killed: [TEST, api],
    });
  });

  it("says as it goes which project's run it starts, and how long each took", () => {
    const api = "tests/api/y.test.ts";
    write(fx.linked, api, branchTest('import { v } from "../../packages/a/src/x.ts";\n'));
    git(fx.linked, "add", api);
    git(fx.linked, "commit", "--quiet", "-m", "test: api");
    const result = againstBase({ STUB_EACH: "1" });
    expect(
      result.output.match(/^falsify: (running|the) .*$/gm)?.map((l) => l.replace(/\d+ s$/, "N s")),
    ).toEqual([
      "falsify: running the unit project (1 file)",
      "falsify: the unit run took N s",
      "falsify: running the api project (1 file)",
      "falsify: the api run took N s",
    ]);
  });
});

const HOOK_MAIN = "crates/bazhen-hook/src/main.rs";
const HOOK_HELPER = "apps/daemon/src/mailbox/hook-command.ts";
const HOOK_TEST = "apps/daemon/src/mailbox/hook.medium.test.ts";
const HOOK_URL = 'new URL("../../../../target/release/bazhen-hook", import.meta.url)';

/**
 * Commits the hook's crate, a crate without a binary, and a daemon helper naming the hook's
 * binary in `helper`, then a change to `changed` and a new test whose own imports are `imports`,
 * and runs falsify against the first commit.
 */
function changeHook(
  changed: string,
  extra: Record<string, string> = {},
  {
    imports = 'import { hook } from "./hook-command.ts";\n',
    helper = HOOK_URL,
    added = {},
  }: { imports?: string; helper?: string; added?: Record<string, string> } = {},
) {
  const tree: Record<string, string> = {
    [HOOK_MAIN]: "fn main() { old hook }\n",
    "crates/bazhen-hook/Cargo.toml": '[package]\nname = "bazhen-hook"\n',
    [OTHER_CRATE]: "pub fn f() { old }\n",
    "crates/holder/Cargo.toml": '[package]\nname = "holder"\n',
    [HOOK_HELPER]: `export const hook = ${helper};\n`,
    "apps/daemon/src/mailbox/via.ts": 'export { hook } from "./hook-command.ts";\n',
    "apps/daemon/package.json": JSON.stringify({
      name: "@bazhen/daemon",
      exports: { "./hook": "./src/mailbox/hook-command.ts" },
    }),
    "crates/bazhen-peer/Cargo.toml": '[package]\nname = "bazhen-peer"\n',
    "crates/bazhen-peer/src/main.rs": "fn main() { peer }\n",
  };
  for (const [path, text] of Object.entries(tree)) write(fx.linked, path, text);
  git(fx.linked, "add", ...Object.keys(tree));
  git(fx.linked, "commit", "--quiet", "-m", "feat: hook1");
  const base = git(fx.linked, "rev-parse", "HEAD").trim();
  write(fx.linked, changed, "fn main() { new hook }\n");
  write(fx.linked, HOOK_TEST, branchTest(imports));
  for (const [path, text] of Object.entries(added)) write(fx.linked, path, text);
  git(fx.linked, "add", changed, HOOK_TEST, ...Object.keys(added));
  git(fx.linked, "commit", "--quiet", "-m", "feat: hook2");
  return falsify(["--base", base], { STUB_SOURCE: HOOK_MAIN, STUB_TEST: HOOK_TEST, ...extra });
}

describe("falsify on a branch with a new test that runs a binary", () => {
  it("runs it with the base's binary where the test looks for it, and kills it on a failure", () => {
    const result = changeHook(HOOK_MAIN);
    expect({
      status: result.status,
      killed: result.output.includes(`KILLED   ${HOOK_TEST} › caps`),
      ranBase: stubLog().includes(
        "RAN target/release/bazhen-hook: BUILT FROM: fn main() { old hook }",
      ),
      sawNewSource: stubLog().includes("new hook"),
    }).toEqual({ status: 0, killed: true, ranBase: true, sawNewSource: false });
  });

  it("fails when it passes against the base's binary", () => {
    expect(changeHook(HOOK_MAIN, { STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringContaining(`SURVIVED ${HOOK_TEST} › caps`),
    });
  });

  it("takes it as unrelated when it passes and its binary isn't built from the Rust that changed", () => {
    expect(changeHook(OTHER_CRATE, { STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringContaining(
        `INVALID  ${HOOK_TEST} › caps (passed; unrelated to the source change)`,
      ),
    });
  });

  it("builds a binary the test reaches only through an import's import, without relating it", () => {
    const result = changeHook(
      HOOK_MAIN,
      { STUB_STATUS: "passed" },
      { imports: 'import { hook } from "./via.ts";\n' },
    );
    expect({
      status: result.status,
      ran: stubLog().includes("RAN target/release/bazhen-hook: BUILT FROM: fn main() { old hook }"),
      unrelated: result.output.includes(
        `INVALID  ${HOOK_TEST} › caps (passed; unrelated to the source change)`,
      ),
    }).toEqual({ status: 1, ran: true, unrelated: true });
  });

  it("takes a failure for no verdict when the test reaches a binary the base doesn't build", () => {
    const result = changeHook(
      HOOK_MAIN,
      {},
      {
        helper: 'new URL("../../../../target/release/bazhen-new", import.meta.url)',
        added: {
          "crates/bazhen-new/Cargo.toml": '[package]\nname = "bazhen-new"\n',
          "crates/bazhen-new/src/main.rs": "fn main() {}\n",
        },
      },
    );
    expect(result).toEqual({
      status: 1,
      output: expect.stringContaining(
        `INVALID  ${HOOK_TEST} › caps (failed; the base builds no target/release/bazhen-new)`,
      ),
    });
  });

  it("builds only the profiles the test reaches a binary in", () => {
    const result = changeHook(
      HOOK_MAIN,
      {},
      {
        helper: 'new URL("../../../../target/debug/bazhen-hook", import.meta.url)',
      },
    );
    expect({
      status: result.status,
      builds: stubLog().match(/^BUILD: .*? in /gm),
      ranBase: stubLog().includes(
        "RAN target/debug/bazhen-hook: BUILT FROM: fn main() { old hook }",
      ),
    }).toEqual({
      status: 0,
      builds: ["BUILD: build --quiet --locked --profile dev -p bazhen-hook --bin bazhen-hook in "],
      ranBase: true,
    });
  });

  it("builds only the binaries the test reaches, not the rest of the workspace's", () => {
    const result = changeHook(HOOK_MAIN);
    expect({
      status: result.status,
      builds: stubLog().match(/^BUILD: .*? in /gm),
      ranPeer: stubLog().includes("RAN target/release/bazhen-peer"),
    }).toEqual({
      status: 0,
      builds: [
        "BUILD: build --quiet --locked --profile release -p bazhen-hook --bin bazhen-hook in ",
      ],
      ranPeer: false,
    });
  });

  it("follows a workspace package's export to the binary its file names", () => {
    const result = changeHook(
      HOOK_MAIN,
      { STUB_STATUS: "passed" },
      { imports: 'import { hook } from "@bazhen/daemon/hook";\n' },
    );
    expect({
      result,
      ranBase: stubLog().includes(
        "RAN target/release/bazhen-hook: BUILT FROM: fn main() { old hook }",
      ),
    }).toEqual({
      result: { status: 1, output: expect.stringContaining(`SURVIVED ${HOOK_TEST} › caps`) },
      ranBase: true,
    });
  });

  it("fails without a verdict when cargo can't list the base's binaries", () => {
    const result = changeHook(HOOK_MAIN, { STUB_FAIL_METADATA: "1" });
    expect({
      status: result.status,
      said: result.output.includes("couldn't list the base's binaries"),
      verdict: /KILLED|SURVIVED|INVALID/.test(result.output),
      built: stubLog().includes("BUILD:"),
    }).toEqual({ status: 1, said: true, verdict: false, built: false });
  });

  it("builds nothing for a path into target/ that names no crate's binary", () => {
    const result = changeHook(
      HOOK_MAIN,
      {},
      {
        helper: 'new URL("../../../../target/release/fixture", import.meta.url)',
      },
    );
    expect({ result, built: stubLog().includes("BUILD:") }).toEqual({
      result: {
        status: 1,
        output: expect.stringContaining("This branch adds tests but no source change to revert."),
      },
      built: false,
    });
  });

  it("ignores a binary an earlier build left behind, and its record", () => {
    const stale = join(fx.linked, "target/falsify/debug/stale");
    write(fx.linked, "target/falsify/debug/stale", '#!/bin/sh\necho "STALE"\n');
    chmodSync(stale, 0o755);
    write(fx.linked, "target/falsify/debug/stale.d", `${stale}: ${fx.linked}/${HOOK_MAIN}\n`);
    const result = changeHook(HOOK_MAIN);
    expect({
      status: result.status,
      ranBase: stubLog().includes("RAN target/release/bazhen-hook:"),
      ranStale: stubLog().includes("STALE"),
    }).toEqual({ status: 0, ranBase: true, ranStale: false });
  });
});

// Every file that names a binary in the repository's target/, and what it names: the binaries
// falsify builds the base's of for a test that reaches one.
const RUNS_BINARIES: Record<string, string[]> = {
  "apps/daemon/src/auth/peer.ts": ["release/bazhen-peer"],
  "apps/daemon/src/env/agent-cli.ts": ["release/bazhen"],
  "apps/daemon/src/mailbox/hook-command.ts": ["release/bazhen-hook"],
  "apps/daemon/src/terminals/holder.ts": ["release-holder/bazhen-holder"],
  "scripts/cli-bench.medium.test.ts": ["release/bazhen"],
  "scripts/engine-replay.ts": ["release/bazhen-holder-replay"],
  "scripts/engine-snapshot.medium.test.ts": ["release/bazhen-holder-replay"],
  "scripts/hook-bench.ts": ["release/bazhen-hook"],
  "scripts/rust-daemon.ts": ["release/bazhen-daemon"],
  "tests/api/daemon.ts": ["release/bazhen"],
  "tests/cli/cli.ts": ["release/bazhen"],
  "tests/support/holder-spawn.ts": ["debug/bazhen-holder", "debug/bazhen-holder-replay"],
};
// Files whose paths into a target/ are data, not binaries they run: falsify itself, its tests'
// fixtures, absolute paths in doctor's fixtures, a store test's scratch folder named target, the
// scratch build tree of the test of where agents find the CLI, and the text of scripts/xtask.sh
// that the standards check pins.
const MENTIONS_TARGET = [
  "apps/daemon/src/env/agent-cli.medium.test.ts",
  "apps/daemon/src/store/store.medium.test.ts",
  "packages/protocol/src/api-fixtures.ts",
  "scripts/check-standards.ts",
  "scripts/falsify.medium.test.ts",
  "scripts/falsify.test.ts",
  "scripts/falsify.ts",
  "tests/cli/daemon.test.ts",
  "tests/cli/fixtures.ts",
];
const FALSIFY_TESTS = ["scripts/falsify.medium.test.ts", "scripts/falsify.test.ts"];
// A string with target as a path segment, that more path follows or a relative or interpolated
// root precedes. An absolute path ending at target, as a CARGO_TARGET_DIR, isn't the repository's.
const TARGET_SEGMENT = /["'`/]target\/|(?:\.\.?|\})\/target["'`]/;
const BARE_TARGET = /["'`]target["'`]/g;
// How far around a bare "target" its shape is read: far enough for a call's first argument, and
// bounded so a file of many of them is read in linear time.
const NEAR = 200;
const KEY_BEFORE =
  /(?:[!=]==?|\bcase|\.includes\(|\b(?:defineProperty|hasOwn|hasOwnProperty|Reflect\.\w+)\(\s*[^(),;]*(?:\([^()]*\)[^(),;]*)*,)\s*$/;
const KEY_AFTER = /^(?:\s*[!=]==?|\s+in\b|[^[\]();]*\]\s*\.includes\()/;
const OBJECT_KEY = [/[{,]\s*$/, /^\s*:/] as const;
// A keyword before `[` begins an array, as `return ["target"]`, so it marks no member.
const MEMBER = [
  /(?:[)\]]|(?<![\w$])(?!(?:return|of|yield|await|in|case|default|typeof|void|else|do|throw|new|delete)\s*\[)[\w$]+)\s*\[\s*$/,
  /^\s*\]/,
] as const;

// How far back a block comment's opening is looked for: far enough for a long doc comment.
const COMMENT_NEAR = 4000;

/**
 * Whether `at` in `text` is inside a comment that its own line starts with: a `//` line, or a
 * block whose lines, walked back from this one, each start with `*` up to one starting with `/*`.
 * A `/*` anywhere else, as in a glob string, opens nothing here.
 */
function inComment(text: string, at: number): boolean {
  const near = text.slice(Math.max(0, at - NEAR), at);
  const line = near.slice(near.lastIndexOf("\n") + 1);
  if (/^\s*\/\//.test(line)) return true;
  if (!/^\s*\/?\*/.test(line)) return false;
  const before = text.slice(Math.max(0, at - COMMENT_NEAR), at);
  for (let end = before.length; end >= 0;) {
    const start = before.lastIndexOf("\n", end - 1) + 1;
    const each = before.slice(start, end);
    if (each.includes("*/")) return false;
    if (/^\s*\/\*/.test(each)) return true;
    if (!/^\s*\*/.test(each)) return false;
    end = start - 1;
  }
  return false;
}

/**
 * Whether the bare "target" from `at` to `end` names a property rather than a path: a key passed
 * to a call that takes one, compared, tested for, an object's key or a member, or a backticked
 * word in a comment's prose.
 */
function namesProperty(text: string, at: number, end: number): boolean {
  const before = text.slice(Math.max(0, at - NEAR), at);
  const after = text.slice(end, end + NEAR);
  if (text[at] === "`" && inComment(text, at)) return true;
  return (
    KEY_BEFORE.test(before) ||
    KEY_AFTER.test(after) ||
    [OBJECT_KEY, MEMBER].some(([b, a]) => b.test(before) && a.test(after))
  );
}

/**
 * Whether `text` spells a path into target/, however a helper spells it. Every bare "target" is
 * read as one unless it names a property, so a helper falsify has never seen fails loud here
 * rather than running the branch's binary.
 */
const mentionsTarget = (text: string) =>
  TARGET_SEGMENT.test(text) ||
  [...text.matchAll(BARE_TARGET)].some((m) => !namesProperty(text, m.index, m.index + m[0].length));
/** The binaries a file names, except the fixtures of falsify's own tests. */
const named = (path: string, text: string) =>
  FALSIFY_TESTS.includes(path) ? [] : namedBinaries(path, text).toSorted();

describe("the repository's tests that run a binary", () => {
  const top = fileURLToPath(new URL("..", import.meta.url));
  const files = execFileSync("git", ["ls-files", "-z", "--", "*.ts", "*.tsx", "*.mts", "*.cts"], {
    cwd: top,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path !== "" && existsSync(join(top, path)))
    .map((path) => ({ path, text: readFileSync(join(top, path), "utf8") }));

  it("name each binary where falsify finds it", () => {
    const naming = files.map(({ path, text }) => [path, named(path, text)] as const);
    expect(Object.fromEntries(naming.filter(([, binaries]) => binaries.length > 0))).toEqual(
      RUNS_BINARIES,
    );
  });

  const read = (path: string) => files.find((f) => f.path === path)?.text;

  it("reach the daemon's binaries through the daemon an api test spawns", () => {
    expect(binariesOf("tests/api/lifecycle.test.ts", read).reached.toSorted()).toEqual([
      "release-holder/bazhen-holder",
      "release/bazhen",
      "release/bazhen-hook",
      "release/bazhen-peer",
    ]);
  });

  const declared = execFileSync("git", ["ls-files", "-z", "--", "crates/*/Cargo.toml"], {
    cwd: top,
    encoding: "utf8",
  })
    .split("\0")
    .filter((path) => path !== "")
    .flatMap((path) => manifestNames(readFileSync(join(top, path), "utf8")));

  it("name binaries the workspace's crates declare", () => {
    const names = Object.values(RUNS_BINARIES).flatMap((bins) =>
      bins.map((b) => b.slice(b.indexOf("/") + 1)),
    );
    expect(names.filter((name) => !declared.includes(name))).toEqual([]);
  });

  it("reach a binary however a test's helper spells its path, or fail here", () => {
    const spellings = [
      'join(repo, "target", "release", name)',
      'join(repo, "target")',
      '"target/" + profile',
      "`${root}/target/${profile}/bazhen`",
      "`target/${profile}/bazhen`",
      '"./target"',
      '"../../target"',
      "`${root}/target`",
      "resolve(root, `target`)",
      'new URL("target", root)',
      'join(dirname(fileURLToPath(new URL(".", import.meta.url))), "..", "target")',
      'join(a(b(c(d(e(f()))))), "target")',
      'join(\n  root,\n  "target",\n  profile,\n)',
      '[root, "target", profile].join("/")',
      '"target" + sep',
      'sep + "target"',
      'joinPath(root, "target")',
      'repoPath("target", "release", "bazhen")',
      'fromRoot("target")',
      'const rel = ["target", "release"];',
      'join(root, ")", "target")',
      'join(root, f(")"), "target")',
      'join(root, /\\)/.source, "target")',
      'join(\n  root, // step 1)\n  "target",\n)',
      '[root, "]", "target"].join("/")',
      'process.env.CARGO_TARGET_DIR ?? "target"',
      'process.env.CARGO_TARGET_DIR || "target"',
      'const dir = "target";',
      '{ cwd: "target" }',
      'join(root, cond ? "target" : "out")',
      '[join(root, "target", "release", "bazhen")].includes(bin)',
      'const u = "http://x"; join(root, `target`)',
      'for (const d of ["target"]) rmSync(join(root, d));',
      'return ["target"];',
      'yield ["target"]',
      'await ["target"]',
      "/* x */ const p = join(root, `target`)",
      " * join(root, `target`)",
      '/* a */ const g = "src/**/*.ts"; join(root, `target`)',
      'const g = "src/**/*.ts";\nclass A {\n  *paths() { yield join(root, `target`) }\n}',
      'const g = "src/**/*.ts";\nconst n = 2\n  * join(root, `target`).length',
      "const s = `/*`;\n * join(root, `target`)",
      "/** doc */\n * join(root, `target`)",
      'export default ["target"];',
    ];
    expect(spellings.filter((s) => !mentionsTarget(s))).toEqual([]);
  });

  it("read no property named target, or other target dir, as a path", () => {
    const spellings = [
      'Object.defineProperty(event, "target", { value: target })',
      'Object.defineProperty(join(root, name), "target", { value })',
      'Object.defineProperty(\n  event,\n  "target",\n  { value },\n)',
      'Reflect.get(event, "target")',
      'Object.hasOwn(event, "target")',
      'kind === "target")',
      '"target" !== kind',
      '["target", "currentTarget"].includes(key)',
      'keys.includes("target")',
      '"target" in event',
      'case "target":',
      'event["target"]',
      '{ "target": node }',
      '{ id, "target": node }',
      "/** Whether `target` has a getter. */",
      "// `target`, a pid or a negated pgid",
      `/**\n * ${"x".repeat(300)}\n * unless a \`target\` is given.\n */`,
      "event.target",
      "e.target/2",
      'CARGO_TARGET_DIR: "/tmp/target"',
    ];
    expect(spellings.filter((s) => mentionsTarget(s))).toEqual([]);
  });

  it("mention a target/ path nowhere else", () => {
    const mentions = files
      .filter(({ text }) => mentionsTarget(text))
      .map(({ path }) => path)
      .filter((path) => !(path in RUNS_BINARIES));
    expect(mentions).toEqual(MENTIONS_TARGET);
  });
});

const MARK = "BROKEN";
/** The most commits with a break falsify runs. */
const MAX_BREAKS = 10;
const V2 = "export const v = 2;";
const GUARD = `Guard: ${TEST} › caps: marks v broken`;
// The new test passes at the base and at HEAD, and fails while the source holds MARK.
const SURVIVES = { STUB_STATUS: "passed", STUB_FAIL_IF: MARK };
// The new test fails as it loads at the base, whose source lacks what it imports, passes at HEAD,
// and fails while the source holds MARK.
const CONTROLLABLE = { ...SURVIVES, STUB_LOAD_IF: "v = 1" };

/** `line` with MARK in a string of its own, which changes its tokens. */
const marked = (line: string) => `${line} "${MARK}";`;

/** A ```diff block changing `from`, the first line of `file` at HEAD, to `to`. */
const breakOf = ({ file = SOURCE, from = V2, to = marked(from) } = {}) =>
  lines("```diff", `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", `-${from}`, `+${to}`, "```");

/** An empty commit on the branch whose message holds `blocks`, then the lines `guards`. */
function guardCommit(blocks: string[], guards: string[] = [GUARD], cleanup = "verbatim"): string {
  const paragraphs = [...blocks, guards.join("\n")].flatMap((text) => ["-m", text]);
  git(
    fx.linked,
    "commit",
    "--quiet",
    "--allow-empty",
    `--cleanup=${cleanup}`,
    "-m",
    "test: guard",
    ...paragraphs,
  );
  return git(fx.linked, "rev-parse", "HEAD").trim().slice(0, 12);
}

/** Amends the branch's commit with `files` added or changed. */
function amendBranch(files: Record<string, string>): void {
  for (const [path, text] of Object.entries(files)) write(fx.linked, path, text);
  git(fx.linked, "add", ...Object.keys(files));
  git(fx.linked, "commit", "--quiet", "--amend", "--no-edit");
}

/** What falsify printed beside the new test `caps`, and its exit. */
function guardVerdict(extra: Record<string, string> = {}, test = TEST) {
  const result = againstBase({ ...SURVIVES, ...extra });
  const line = result.output.split("\n").find((l) => l.includes(` ${test} › caps`)) ?? "";
  return { status: result.status, line: line.trim(), leftovers: leftovers() };
}

/** Falsify's verdict on `caps` under one guard's marker break, and that guard's commit. */
function underOneBreak(extra: Record<string, string>) {
  const commit = guardCommit([breakOf()]);
  return { commit, ...guardVerdict(extra) };
}

/** The verdict on `caps` when its guard doesn't hold, for the reason `why`. */
const unheld = (why: string) => ({
  status: 1,
  line: `SURVIVED ${TEST} › caps (its guard doesn't hold: ${why})`,
  leftovers: [],
});
const noVerdict = (commit: string) =>
  `it has no pass or fail under the break in ${commit} (a timeout, or no result)`;
const notItsOwn = (commit: string) =>
  `it fails under the break in ${commit}, but not on an assertion of its own`;

/** The source each vitest run under a guard's break saw, in order. */
const sourcesUnderBreaks = () =>
  stubLog()
    .split(/^ARGS: /m)
    .filter((run) => /falsify-report-break-\d+-/.test(run.split("\n")[0] ?? ""))
    .map((run) => /^SOURCE: (.*)$/m.exec(run)?.[1]);

describe("falsify on a branch that guards a test of behaviour the base already has", () => {
  it("keeps a surviving test its guard's break fails on an assertion of its own, printing that assertion", () => {
    const commit = guardCommit([breakOf()]);
    const result = againstBase(SURVIVES);
    expect({
      status: result.status,
      guarded: result.output.includes(`GUARDED  ${TEST} › caps\n`),
      under: result.output.includes(
        `under the break in ${commit}: AssertionError: expected 2 to be 3`,
      ),
      leftovers: leftovers(),
    }).toEqual({ status: 0, guarded: true, under: true, leftovers: [] });
  });

  it("applies a break whose last blank context line git's message cleanup emptied", () => {
    amendBranch({ [SOURCE]: `${V2}\n\nexport const w = 1;\n` });
    guardCommit(
      [
        lines(
          "```diff",
          `--- a/${SOURCE}`,
          `+++ b/${SOURCE}`,
          "@@ -1,2 +1,2 @@",
          `-${V2}`,
          `+${marked(V2)}`,
          " ",
          "```",
        ),
      ],
      [GUARD],
      "default",
    );
    const message = git(fx.linked, "log", "-1", "--format=%B");
    expect({
      emptied: message.includes(`+${marked(V2)}\n\n\`\`\``),
      ...guardVerdict(),
    }).toEqual({
      emptied: true,
      status: 0,
      line: `GUARDED  ${TEST} › caps`,
      leftovers: [],
    });
  });

  it("leaves a guarded test SURVIVED when it passes under the break", () => {
    const { commit, ...verdict } = underOneBreak({ STUB_FAIL_IF: "NOT THERE" });
    expect(verdict).toEqual(unheld(`it passes under the break in ${commit}`));
  });

  it("leaves a guarded test SURVIVED when it times out under the break", () => {
    const { commit, ...verdict } = underOneBreak({
      STUB_FAIL_AS: `Error: Test timed out in 30000ms.\\n    at ${TEST}:3:5`,
    });
    expect(verdict).toEqual(unheld(noVerdict(commit)));
  });

  it("leaves a guarded test SURVIVED when it fails on a TypeError at its own frame", () => {
    const { commit, ...verdict } = underOneBreak({
      STUB_FAIL_AS: `TypeError: v is undefined\\n    at ${TEST}:3:5`,
    });
    expect(verdict).toEqual(unheld(notItsOwn(commit)));
  });

  it("leaves a guarded test SURVIVED when it fails on an assertion in a helper", () => {
    const { commit, ...verdict } = underOneBreak({
      STUB_FAIL_AS: `AssertionError: expected 2 to be 3\\n    at packages/a/src/helper.ts:1:1\\n    at ${TEST}:3:5`,
    });
    expect(verdict).toEqual(unheld(notItsOwn(commit)));
  });

  it("leaves a guarded test SURVIVED when its file throws as it loads", () => {
    const { commit, ...verdict } = underOneBreak({ STUB_FAIL_LOAD: "1" });
    expect(verdict).toEqual(unheld(noVerdict(commit)));
  });

  it("leaves a guarded test SURVIVED when it times out after a soft assertion fails", () => {
    const { commit, ...verdict } = underOneBreak({
      STUB_FAIL_AS: `AssertionError: expected 2 to be 3\\n    at ${TEST}:3:5","Error: Test timed out in 30000ms.`,
    });
    expect(verdict).toEqual(unheld(noVerdict(commit)));
  });

  it("leaves a guarded test SURVIVED when it fails at HEAD without the break", () => {
    const { commit: _, ...verdict } = underOneBreak({ STUB_FAIL_IF: V2 });
    expect(verdict).toEqual(
      unheld("it doesn't pass at HEAD without a break, so a break failing it shows nothing"),
    );
  });

  it("leaves SURVIVED a test a Guard: names in a commit with no break", () => {
    const commit = guardCommit([]);
    expect(guardVerdict().line).toBe(
      `SURVIVED ${TEST} › caps (its guard doesn't hold: commit ${commit} holds no \`\`\`diff block)`,
    );
  });

  it("refuses, before it applies anything, a break the test feeds itself through or never loads", () => {
    const fixture = "packages/a/src/store/fixture.ts";
    const support = "packages/a/src/testing/fake.ts";
    const unloaded = "packages/a/src/other.ts";
    amendBranch({
      [fixture]: "export const f = 2;\n",
      [support]: "export const g = 2;\n",
      [unloaded]: "export const h = 2;\n",
      [TEST]: branchTest(
        'import { v } from "./x.ts";\nimport { f } from "./store/fixture.ts";\nimport { g } from "./testing/fake.ts";\nit("v", () => {});\n',
      ),
    });
    const breaks = [
      [fixture, "export const f = 2;", "is test support"],
      [support, "export const g = 2;", "is test support"],
      [unloaded, "export const h = 2;", "isn't source the branch changed that the test imports"],
      [TEST, 'import { v } from "./x.ts";', "is a test file"],
    ] as const;
    const refused = breaks.map(([file, from, why]) => {
      const commit = guardCommit([breakOf({ file, from })]);
      const verdict = guardVerdict();
      git(fx.linked, "reset", "--quiet", "--hard", "HEAD~1");
      writeFileSync(fx.log, "");
      return verdict.line.endsWith(
        `(its guard doesn't hold: the break in ${commit}: ${file} ${why})`,
      );
    });
    expect(refused).toEqual([true, true, true, true]);
  });

  it("refuses a break of a file outside the source falsify reverts", () => {
    amendBranch({ "package.json": "{}\n", "tests/support/x.ts": "export const s = 1;\n" });
    const verdicts = [
      ["package.json", "{}"],
      ["tests/support/x.ts", "export const s = 1;"],
    ].map(([file = "", from = ""]) => {
      const commit = guardCommit([breakOf({ file, from })]);
      const verdict = guardVerdict();
      git(fx.linked, "reset", "--quiet", "--hard", "HEAD~1");
      return verdict.line.endsWith(
        `the break in ${commit}: ${file} isn't source the branch changed that the test imports)`,
      );
    });
    expect(verdicts).toEqual([true, true]);
  });

  it("refuses a break that creates, renames or changes a mode, or is binary", () => {
    const breaks = [
      lines(
        "```diff",
        "diff --git a/packages/a/src/n.ts b/packages/a/src/n.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/packages/a/src/n.ts",
        "@@ -0,0 +1 @@",
        "+x",
        "```",
      ),
      lines(
        "```diff",
        `diff --git a/${SOURCE} b/packages/a/src/y.ts`,
        "similarity index 100%",
        `rename from ${SOURCE}`,
        "rename to packages/a/src/y.ts",
        "```",
      ),
      lines(
        "```diff",
        `diff --git a/${SOURCE} b/${SOURCE}`,
        "old mode 100644",
        "new mode 100755",
        "```",
      ),
      lines(
        "```diff",
        `diff --git a/${SOURCE} b/${SOURCE}`,
        "index 1111111..2222222 100644",
        "Binary files a/x and b/x differ",
        "```",
      ),
    ];
    const verdicts = breaks.map((block) => {
      const commit = guardCommit([block]);
      const verdict = guardVerdict();
      git(fx.linked, "reset", "--quiet", "--hard", "HEAD~1");
      return [
        verdict.status,
        verdict.line.includes(`the break in ${commit} must only modify text`),
      ];
    });
    expect(verdicts).toEqual([
      [1, true],
      [1, true],
      [1, true],
      [1, true],
    ]);
  });

  it("refuses a break that doesn't apply to HEAD, saying how to commit one", () => {
    const commit = guardCommit([breakOf({ from: "export const v = 7;" })]);
    expect(guardVerdict().line).toContain(
      `the break in ${commit} doesn't apply to HEAD. If git's message cleanup collapsed its blank lines, commit it with --cleanup=verbatim`,
    );
  });

  it("refuses a guard of a test written with .fails", () => {
    renameTest('it("v", () => {});\nit.fails("caps", () => {});');
    guardCommit([breakOf()]);
    expect(guardVerdict().line).toContain("it is written with .fails, which inverts its result");
  });

  it("runs each break alone, on HEAD reset after the one before", () => {
    guardCommit([breakOf({ to: `${V2} "${MARK} one";` })]);
    guardCommit([breakOf({ to: `${V2} "${MARK} two";` })]);
    const verdict = guardVerdict();
    expect({ verdict, sources: sourcesUnderBreaks() }).toEqual({
      verdict: { status: 0, line: `GUARDED  ${TEST} › caps`, leftovers: [] },
      sources: [`${V2} "${MARK} two";`, `${V2} "${MARK} one";`],
    });
  });

  it("keeps a test only when every Guard: naming it holds", () => {
    guardCommit([breakOf()]);
    const harmless = guardCommit([breakOf({ to: `${V2} "harmless";` })]);
    const { status, line } = guardVerdict();
    expect({ status, line }).toEqual({
      status: 1,
      line: `SURVIVED ${TEST} › caps (its guard doesn't hold: it passes under the break in ${harmless})`,
    });
  });

  it("judges on its own each test one break's Guard: lines name", () => {
    amendBranch({ [MOVED]: `${IMPORTS}it("caps", () => {});\n` });
    guardCommit([breakOf()], [GUARD, `Guard: ${MOVED} › caps: marks v broken`]);
    const both = guardVerdict({ STUB_EACH: "1" });
    const moved = againstBase({ ...SURVIVES, STUB_EACH: "1", STUB_FAIL_FILES: TEST }).output;
    expect({
      both: both.status,
      held: moved.includes(`GUARDED  ${TEST} › caps`),
      passed: moved.includes(
        `SURVIVED ${MOVED} › caps (its guard doesn't hold: it passes under the break in`,
      ),
    }).toEqual({ both: 0, held: true, passed: true });
  });

  it("fails on a Guard: naming a test that didn't survive, or no new TypeScript test", () => {
    guardCommit([breakOf()], [GUARD, "Guard: tests::b_is_two: a Rust test's path"]);
    const result = againstBase({ STUB_FAIL_IF: MARK });
    expect({
      status: result.status,
      killed: result.output.includes(`  ${TEST} › caps (KILLED)`),
      stray: result.output.includes("Guard: tests::b_is_two: a Rust test's path"),
    }).toEqual({ status: 1, killed: true, stray: true });
  });

  it("refuses a break that changes only comments or layout", () => {
    const commit = guardCommit([breakOf({ to: `${V2} // ${MARK}` })]);
    expect(guardVerdict()).toEqual(
      unheld(`the break in ${commit} changes no code, only comments or layout`),
    );
  });

  it("runs as many breaks as falsify allows", () => {
    for (let i = 0; i < MAX_BREAKS; i++) guardCommit([breakOf({ to: `${V2} "${MARK} ${i}";` })]);
    const verdict = guardVerdict();
    expect({ ...verdict, runs: sourcesUnderBreaks().length }).toEqual({
      status: 0,
      line: `GUARDED  ${TEST} › caps`,
      leftovers: [],
      runs: MAX_BREAKS,
    });
  });

  it("counts toward its cap only the commits that carry a break", () => {
    for (let i = 0; i < MAX_BREAKS; i++) guardCommit([breakOf({ to: `${V2} "${MARK} ${i}";` })]);
    const bare = guardCommit([]);
    const { output } = againstBase(SURVIVES);
    expect({
      capped: output.includes("commits carry a guard's break"),
      refused: output.includes(`commit ${bare} holds no \`\`\`diff block`),
    }).toEqual({ capped: false, refused: true });
  });

  it("refuses more breaks than falsify runs, before it installs anything", () => {
    for (let i = 0; i <= MAX_BREAKS; i++) guardCommit([breakOf()]);
    const result = againstBase(SURVIVES);
    expect({
      status: result.status,
      said: result.output.includes(
        `${MAX_BREAKS + 1} commits carry a guard's break, and falsify runs at most ${MAX_BREAKS}`,
      ),
      installed: stubLog().includes("ARGS: install"),
    }).toEqual({ status: 1, said: true, installed: false });
  });

  it("refuses, before it installs anything, a break that leaves a quiet file signalling", () => {
    guardCommit([
      lines(
        "```diff",
        `--- a/${SOURCE}`,
        `+++ b/${SOURCE}`,
        "@@ -1 +1 @@",
        `-${V2}`,
        '+import { signalGroup } from "@bazhen/host-guard";',
        `+${V2}`,
        '+export const stop = (c) => signalGroup(c, "SIGTERM");',
        "```",
      ),
    ]);
    const result = againstBase({ ...SURVIVES, BZ_FALSIFY_AS_HOST: "1" });
    expect({
      status: result.status,
      named: result.output.includes(`  ${SOURCE}`),
      installed: stubLog().includes("ARGS: install"),
      leftovers: leftovers(),
    }).toEqual({ status: 1, named: true, installed: false, leftovers: [] });
  });

  it("leaves the checkout's staged and unstaged changes as they were", () => {
    guardCommit([breakOf()]);
    write(fx.linked, "packages/a/src/staged.ts", "export const s = 1;\n");
    git(fx.linked, "add", "packages/a/src/staged.ts");
    write(fx.linked, SOURCE, "export const v = 9;\n");
    const verdict = guardVerdict();
    expect({
      verdict: verdict.status,
      staged: git(fx.linked, "diff", "--cached", "--name-only"),
      unstaged: git(fx.linked, "diff", "--name-only"),
      source: readFileSync(join(fx.linked, SOURCE), "utf8"),
    }).toEqual({
      verdict: 0,
      staged: "packages/a/src/staged.ts\n",
      unstaged: `${SOURCE}\n`,
      source: "export const v = 9;\n",
    });
  });

  it("leaves SURVIVED a guarded test that runs a Rust binary", () => {
    amendBranch({
      "crates/bazhen/src/main.rs": "fn main() {}\n",
      "crates/bazhen/Cargo.toml": '[package]\nname = "bazhen"\n',
      [TEST]: branchTest(`${IMPORTS}const cli = "target/release/bazhen";\nit("v", () => {});\n`),
    });
    guardCommit([breakOf()]);
    expect(guardVerdict().line).toContain("it runs a Rust binary or both daemons");
  });

  it("leaves SURVIVED a guarded test in a file the Rust daemon's list names", () => {
    const listed = 'import { v } from "../../packages/a/src/x.ts";\n';
    const v3 = "export const v = 3;";
    const guard = lines(
      "test: guard",
      "",
      breakOf({ from: v3 }),
      `Guard: ${LISTED_TEST} › caps: marks v broken`,
    );
    const result = changeDaemon(
      DAEMON_MAIN,
      { ...SURVIVES, STUB_RUST_STATUS: "passed" },
      { imports: listed, added: { [SOURCE]: `${v3}\n` }, guard },
    );
    expect(result.output).toMatch(
      new RegExp(`SURVIVED ${escape(LISTED_TEST)} › caps .*it runs a Rust binary or both daemons`),
    );
  });
});

const MAX_CONTROLS = 30;
const V1 = "export const v = 1;";

/** Falsify's verdict on `caps`, INVALID by reverting, under one control's marker break. */
function underOneControl(extra: Record<string, string> = {}) {
  const commit = guardCommit([breakOf()], [CONTROL]);
  return { commit, ...guardVerdict({ ...CONTROLLABLE, ...extra }) };
}

/** The verdict line on `caps` when its control doesn't hold, for the reason `why`. */
const uncontrolledLine = (why: string) =>
  expect.stringMatching(
    new RegExp(
      `^INVALID  ${escape(TEST)} › caps .*\\(its control doesn't hold: ${escape(why)}\\)$`,
    ),
  );

/** The verdict on `caps` when its control doesn't hold, for the reason `why`. */
const uncontrolled = (why: string) => ({ status: 1, line: uncontrolledLine(why), leftovers: [] });

/** Makes the branch change only its test, so falsify has nothing to revert. */
const testOnlyBranch = () => amendBranch({ [SOURCE]: `${V1}\n` });

describe("falsify on a branch that controls a test reverting can't judge", () => {
  it("leaves a controlled test INVALID when it passes under the break", () => {
    const { commit, ...verdict } = underOneControl({ STUB_FAIL_IF: "NOT THERE" });
    expect(verdict).toEqual(uncontrolled(`it passes under the break in ${commit}`));
  });

  it("leaves a controlled test INVALID when it times out under the break", () => {
    const { commit, ...verdict } = underOneControl({
      STUB_FAIL_AS: `Error: Test timed out in 30000ms.\\n    at ${TEST}:3:5`,
    });
    expect(verdict).toEqual(uncontrolled(noVerdict(commit)));
  });

  it("leaves a controlled test INVALID when it fails on a TypeError at its own frame", () => {
    const { commit, ...verdict } = underOneControl({
      STUB_FAIL_AS: `TypeError: v is undefined\\n    at ${TEST}:3:5`,
    });
    expect(verdict).toEqual(uncontrolled(notItsOwn(commit)));
  });

  it("leaves a controlled test INVALID when it fails on an assertion in a helper", () => {
    const { commit, ...verdict } = underOneControl({
      STUB_FAIL_AS: `AssertionError: expected 2 to be 3\\n    at packages/a/src/helper.ts:1:1\\n    at ${TEST}:3:5`,
    });
    expect(verdict).toEqual(uncontrolled(notItsOwn(commit)));
  });

  it("leaves a controlled test INVALID when it fails at HEAD without the break", () => {
    const { commit: _, ...verdict } = underOneControl({ STUB_FAIL_IF: V2 });
    expect(verdict).toEqual(
      uncontrolled("it doesn't pass at HEAD without a break, so a break failing it shows nothing"),
    );
  });

  it("refuses a break of a test file, test support, a manifest or a file the test doesn't import", () => {
    const fixture = "packages/a/src/store/fixture.ts";
    const manifest = "packages/a/package.json";
    const unloaded = "packages/a/src/other.ts";
    amendBranch({
      [fixture]: "export const f = 2;\n",
      [manifest]: '{ "name": "a" }\n',
      [unloaded]: "export const h = 2;\n",
      [TEST]: branchTest(`${IMPORTS}import { f } from "./store/fixture.ts";\nit("v", () => {});\n`),
    });
    const breaks = [
      [TEST, IMPORTS.trimEnd(), "is a test file"],
      [fixture, "export const f = 2;", "is test support"],
      [manifest, '{ "name": "a" }', "isn't source the test imports"],
      [unloaded, "export const h = 2;", "isn't source the test imports"],
    ] as const;
    const refused = breaks.map(([file, from, why]) => {
      const commit = guardCommit(
        [breakOf({ file, from, to: from.replace(/\d|a/, "9") })],
        [CONTROL],
      );
      const verdict = guardVerdict(CONTROLLABLE);
      git(fx.linked, "reset", "--quiet", "--hard", "HEAD~1");
      return uncontrolledLine(`the break in ${commit}: ${file} ${why}`).asymmetricMatch(
        verdict.line,
      );
    });
    expect(refused).toEqual([true, true, true, true]);
  });

  it("controls a test on a branch with no source change, by a break of code the test pins", () => {
    testOnlyBranch();
    const before = againstBase(SURVIVES);
    const commit = guardCommit([breakOf({ from: V1 })], [CONTROL]);
    const after = againstBase(SURVIVES);
    expect({
      before: before.output.includes("This branch adds tests but no source change to revert."),
      status: after.status,
      controlled: after.output.includes(`  CONTROLLED ${TEST} › caps\n`),
      under: after.output.includes(`under the break in ${commit}: AssertionError`),
      sources: sourcesUnderBreaks(),
      leftovers: leftovers(),
    }).toEqual({
      before: true,
      status: 0,
      controlled: true,
      under: true,
      sources: [`${V1} "${MARK}";`],
      leftovers: [],
    });
  });

  it("refuses, before it installs anything, a break that leaves a quiet file signalling on a branch with no source change", () => {
    testOnlyBranch();
    guardCommit(
      [
        lines(
          "```diff",
          `--- a/${SOURCE}`,
          `+++ b/${SOURCE}`,
          "@@ -1 +1 @@",
          `-${V1}`,
          '+import { signalGroup } from "@bazhen/host-guard";',
          `+${V1}`,
          '+export const stop = (c) => signalGroup(c, "SIGTERM");',
          "```",
        ),
      ],
      [CONTROL],
    );
    const result = againstBase({ ...SURVIVES, BZ_FALSIFY_AS_HOST: "1" });
    expect({
      status: result.status,
      named: result.output.includes(`  ${SOURCE}`),
      installed: stubLog().includes("ARGS: install"),
      leftovers: leftovers(),
    }).toEqual({ status: 1, named: true, installed: false, leftovers: [] });
  });

  it("refuses a commit carrying both Guard: and Control: lines, before it installs anything", () => {
    const commit = guardCommit([breakOf()], [GUARD, CONTROL]);
    const result = againstBase(CONTROLLABLE);
    expect({
      status: result.status,
      said: result.output.includes(`Give each kind a commit of its own:\n  ${commit}\n`),
      installed: stubLog().includes("ARGS: install"),
    }).toEqual({ status: 1, said: true, installed: false });
  });

  it("runs as many controls' breaks as falsify allows", () => {
    for (let i = 0; i < MAX_CONTROLS; i++) {
      guardCommit([breakOf({ to: `${V2} "${MARK} ${i}";` })], [CONTROL]);
    }
    const verdict = guardVerdict(CONTROLLABLE);
    expect({ ...verdict, runs: sourcesUnderBreaks().length }).toEqual({
      status: 0,
      line: `CONTROLLED ${TEST} › caps`,
      leftovers: [],
      runs: MAX_CONTROLS,
    });
  });

  it("refuses more controls' breaks than falsify runs, before it installs anything", () => {
    for (let i = 0; i <= MAX_CONTROLS; i++) guardCommit([breakOf()], [CONTROL]);
    const result = againstBase(CONTROLLABLE);
    expect({
      status: result.status,
      said: result.output.includes(
        `${MAX_CONTROLS + 1} commits carry a control's break, and falsify runs at most ${MAX_CONTROLS}`,
      ),
      installed: stubLog().includes("ARGS: install"),
    }).toEqual({ status: 1, said: true, installed: false });
  });

  it("prints, and doesn't run, a control of a test reverting killed", () => {
    guardCommit([breakOf()], [CONTROL]);
    const result = againstBase();
    expect({
      status: result.status,
      unused: result.output.includes(`so their breaks didn't run:\n  ${TEST} › caps (KILLED)\n`),
      runs: sourcesUnderBreaks().length,
    }).toEqual({ status: 0, unused: true, runs: 0 });
  });

  it("fails on a Control: naming no new test", () => {
    guardCommit([breakOf()], [`Control: ${TEST} › nothing: marks v broken -> expected 2, got 3`]);
    const result = againstBase();
    expect({
      status: result.status,
      stray: result.output.includes(`  Control: ${TEST} › nothing: marks v broken\n`),
    }).toEqual({ status: 1, stray: true });
  });

  it("asks a test that runs a Rust binary for a Control: line alone, and takes one", () => {
    const before = changeCli(OTHER_CRATE, { STUB_STATUS: "passed" });
    git(
      fx.linked,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "test: control",
      "-m",
      `Control: ${CLI_TEST} › caps: x -> y`,
    );
    const base = git(fx.linked, "rev-parse", "HEAD~2").trim();
    const after = falsify(["--base", base], {
      STUB_SOURCE: CLI_MAIN,
      STUB_TEST: CLI_TEST,
      STUB_STATUS: "passed",
    });
    expect({
      before: before.status,
      asks: before.output.includes(
        `These run a Rust binary or hold both daemons, so each needs a control of its own.`,
      ),
      after: after.status,
    }).toEqual({ before: 1, asks: true, after: 0 });
  });
});

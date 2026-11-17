// Runs scripts/falsify.ts against a branch in a linked worktree of a throwaway repository, with a
// bogus GIT_DIR and GIT_INDEX_FILE in its environment that must never reach git or the tests. A
// stub `pnpm` stands in for install, the binaries' build and vitest, and logs what it saw: its
// build makes a binary of each crate with a src/main.rs, in the profile it is given, that prints
// that file. A stub `cargo-nextest` lists the Rust tests named in the tree's rust-tests.txt and
// runs them, failing each on the line of kills.txt whose marker the Rust source holds; a stub
// `cargo-mutants` lists mutants.json.

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
import { isAlive, signalOwnChild } from "@bazhen/host-guard";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installCommand } from "./cargo-gate.ts";
import { binariesOf, manifestNames, namedBinaries } from "./falsify.ts";
import { inSignalSandbox } from "./signal-paths.ts";

const FALSIFY = fileURLToPath(new URL("falsify.ts", import.meta.url));
const SOURCE = "packages/a/src/x.ts";
const CLI_MAIN = "crates/bazhen/src/main.rs";
const TEST = "packages/a/src/x.test.ts";
const CONTROL = "Control: return v = 1 -> caps failed: expected 2, got 1";

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
  run)
    shift
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
    folder="$3"
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
    ;;
  exec)
    if [ "$3" = list ]; then
      [ "\${STUB_FAIL_LIST:-}" = 1 ] && exit 1
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
    if [ "\${STUB_HANG_VITEST:-}" = 1 ]; then
      echo "HANGING $$" >> "$STUB_LOG"
      trap 'echo TERMED >> "$STUB_LOG"' TERM
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
      printf '%s{"name":"%s/%s","status":"failed","assertionResults":[{"title":"caps","status":"%s","failureMessages":[%s]}]}' "$sep" "$(pwd)" "$file" "$status" "$messages" >> "$out"
      sep=","
    done
    printf ']}' >> "$out"
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

// \`cargo metadata\`: each crate whose manifest is \`[package]\\nname = "<crate's folder>"\`, with a
// binary of that name when it has a src/main.rs.
const STUB_CARGO = `#!/bin/sh
echo "CARGO: $*" >> "$STUB_LOG"
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
    renameTest('it("caps", () => {});', "Renamed: v -> caps");
    const renamed = againstBase({ STUB_STATUS: "passed" });
    renameTest('it("caps", () => void v);', "Renamed: v -> caps");
    const rewritten = againstBase({ STUB_STATUS: "passed" });
    expect({ renamed, rewritten }).toEqual({
      renamed: {
        status: 0,
        output: expect.stringContaining(`RENAMED ${TEST} › caps (was "v"), not judged`),
      },
      rewritten: {
        status: 1,
        output: expect.stringMatching(
          /Renamed: v -> caps doesn't apply \(.*"caps" isn't "v" with only its title changed\)[\s\S]*SURVIVED/,
        ),
      },
    });
  });

  it("names the Renamed trailer a surviving test needs when it is the base's under a new title", () => {
    renameTest('it("caps", () => {});');
    expect(againstBase({ STUB_STATUS: "passed" })).toEqual({
      status: 1,
      output: expect.stringMatching(/SURVIVED[\s\S]*\n {2}Renamed: v -> caps\n/),
    });
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

  it("asks a control for a passing test that imports no script the branch changed", () => {
    const unrelated = { path: "scripts/y.test.ts", text: branchTest("") };
    const before = changeScript(SCRIPT, unrelated, { STUB_STATUS: "passed" });
    git(fx.linked, "commit", "--quiet", "--allow-empty", "-m", "test: control", "-m", CONTROL);
    const after = falsify(["--base", git(fx.linked, "rev-parse", "HEAD~2").trim()], {
      STUB_SOURCE: SCRIPT,
      STUB_TEST: unrelated.path,
      STUB_STATUS: "passed",
    });
    expect({ before, after: after.status }).toEqual({
      before: {
        status: 1,
        output: expect.stringContaining("(passed; unrelated to the source change)"),
      },
      after: 0,
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
        env: env({ STUB_HANG: "1" }),
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
      pointsAt: result.output.includes("pnpm test:real falsify"),
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
        `^BUILD: build:bins --profile release -p bazhen --bin bazhen in ${worktree} to ` +
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

describe("falsify on a branch with new tests in two vitest projects", () => {
  it("fails without a verdict when vitest can't name the tests' projects", () => {
    const result = againstBase({ STUB_FAIL_LIST: "1" });
    expect({
      status: result.status,
      said: result.output.includes("couldn't name the projects of the tests to judge"),
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
        ?.map((line) => line.replace(/ --reporter=json .*$/, "")),
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
      builds: ["BUILD: build:bins --profile dev -p bazhen-hook --bin bazhen-hook in "],
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
      builds: ["BUILD: build:bins --profile release -p bazhen-hook --bin bazhen-hook in "],
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
  "apps/daemon/src/mailbox/hook-command.ts": ["release/bazhen-hook"],
  "apps/daemon/src/terminals/holder.ts": ["release-holder/bazhen-holder"],
  "scripts/cli-bench.medium.test.ts": ["release/bazhen"],
  "scripts/engine-replay.ts": ["release/bazhen-holder-replay"],
  "scripts/engine-snapshot.medium.test.ts": ["release/bazhen-holder-replay"],
  "scripts/hook-bench.ts": ["release/bazhen-hook"],
  "tests/api/daemon.ts": ["release/bazhen"],
  "tests/cli/cli.ts": ["release/bazhen"],
  "tests/support/holder-spawn.ts": ["debug/bazhen-holder", "debug/bazhen-holder-replay"],
};
// Files whose paths into a target/ are data, not binaries they run: falsify itself, its tests'
// fixtures, absolute paths in doctor's fixtures, and a store test's scratch folder named target.
const MENTIONS_TARGET = [
  "apps/daemon/src/store/store.medium.test.ts",
  "packages/protocol/src/api-fixtures.ts",
  "scripts/falsify.medium.test.ts",
  "scripts/falsify.test.ts",
  "scripts/falsify.ts",
  "tests/cli/daemon.test.ts",
  "tests/cli/fixtures.ts",
];
const FALSIFY_TESTS = ["scripts/falsify.medium.test.ts", "scripts/falsify.test.ts"];
// Any spelling of a path into target/: a quoted or slashed `target/`, or "target" joined to more,
// or ending a join whose result is joined to more later.
const TARGET_MENTION = /["'`/]target\/|["']target["']\s*[,+)]/;
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
    ];
    expect(spellings.filter((s) => TARGET_MENTION.test(s))).toEqual(spellings);
  });

  it("mention a target/ path nowhere else", () => {
    const mentions = files
      .filter(({ text }) => TARGET_MENTION.test(text))
      .map(({ path }) => path)
      .filter((path) => !(path in RUNS_BINARIES));
    expect(mentions).toEqual(MENTIONS_TARGET);
  });
});

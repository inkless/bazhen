// Runs scripts/falsify.ts as the commit-msg hook of a real `git commit` in a linked worktree of a
// throwaway repository, where git exports GIT_DIR and GIT_INDEX_FILE to the hook. A stub `pnpm`
// stands in for install and vitest, and logs what it saw.

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

type Fixture = { root: string; repo: string; linked: string; tmp: string; log: string };

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
  };
  mkdirSync(fx.tmp);
  write(root, "bin/pnpm", STUB_PNPM);
  chmodSync(join(root, "bin/pnpm"), 0o755);
  writeFileSync(fx.log, "");
  write(root, "hooks/commit-msg", `#!/bin/sh\nexec node "${FALSIFY}" --staged "$1"\n`);
  chmodSync(join(root, "hooks/commit-msg"), 0o755);

  mkdirSync(fx.repo);
  git(fx.repo, "init", "--quiet", "--initial-branch=main");
  git(fx.repo, "config", "user.name", "Falsify Test");
  git(fx.repo, "config", "user.email", "falsify@example.com");
  write(fx.repo, SOURCE, "export const v = 1;\n");
  write(fx.repo, TEST, 'it("v", () => {});\n');
  git(fx.repo, "add", SOURCE, TEST);
  git(fx.repo, "commit", "--quiet", "-m", "feat: v1");
  git(fx.repo, "worktree", "add", "--quiet", "-b", "work", fx.linked);
  git(fx.linked, "config", "core.hooksPath", join(root, "hooks"));

  write(fx.linked, SOURCE, "export const v = 2;\n");
  write(fx.linked, TEST, 'it("v", () => {});\nit("caps", () => {});\n');
  git(fx.linked, "add", SOURCE, TEST);
});

afterEach(() => {
  rmSync(fx.root, { recursive: true, force: true });
});

function commit(extra: Record<string, string> = {}) {
  return spawnSync("git", ["commit", "-m", "feat: v2"], {
    cwd: fx.linked,
    env: env(extra),
    encoding: "utf8",
    timeout: 30_000,
  });
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

describe("falsify as the commit-msg hook in a linked worktree", () => {
  it("runs the new test against the old source, with no hook git variables", () => {
    const result = commit();
    expect({
      status: result.status,
      sawHookVars: /^GIT_(DIR|INDEX_FILE|WORK_TREE)=/m.test(stubLog()),
      sawOldSource: stubLog().includes("SOURCE: export const v = 1;"),
      sawNewSource: stubLog().includes("SOURCE: export const v = 2;"),
      sawNewTest: stubLog().includes('it("caps"'),
    }).toEqual({
      status: 0,
      sawHookVars: false,
      sawOldSource: true,
      sawNewSource: false,
      sawNewTest: true,
    });
  });

  it("leaves the index intact and no temporary worktree behind", () => {
    expect(commit().status).toBe(0);
    expect({ status: git(fx.linked, "status", "--porcelain"), leftovers: leftovers() }).toEqual({
      status: "",
      leftovers: [],
    });
  });

  it("rejects the commit when the new test passes without the change", () => {
    const result = commit({ STUB_STATUS: "passed" });
    expect({ status: result.status, output: result.stdout + result.stderr }).toEqual({
      status: 1,
      output: expect.stringContaining("SURVIVED"),
    });
    expect(leftovers()).toEqual([]);
  });

  it("falls back to an online install when the offline one fails", () => {
    expect({ status: commit({ STUB_FAIL_OFFLINE: "1" }).status, log: stubLog() }).toEqual({
      status: 0,
      log: expect.stringContaining("--prefer-offline"),
    });
  });

  it("skips a merge commit", () => {
    const gitDir = git(fx.linked, "rev-parse", "--absolute-git-dir").trim();
    writeFileSync(join(gitDir, "MERGE_HEAD"), git(fx.linked, "rev-parse", "HEAD"));
    writeFileSync(join(fx.root, "message"), "feat: v2\n");
    const result = spawnSync("node", [FALSIFY, "--staged", join(fx.root, "message")], {
      cwd: fx.linked,
      env: env({ STUB_STATUS: "passed" }),
      encoding: "utf8",
      timeout: 30_000,
    });
    expect({ status: result.status, log: stubLog() }).toEqual({ status: 0, log: "" });
  });

  it("sweeps a stale worktree whose pid is dead and keeps one whose pid is alive", () => {
    const dead = lockedWorktree("bz-falsify-dead", 999_999);
    const live = lockedWorktree("bz-falsify-live", process.pid);
    expect(commit().status).toBe(0);
    expect({
      listed: falsifyWorktrees(fx.repo),
      deadFolder: existsSync(dead),
      liveFolder: existsSync(live),
    }).toEqual({ listed: [`worktree ${live}`], deadFolder: false, liveFolder: true });
  });
});

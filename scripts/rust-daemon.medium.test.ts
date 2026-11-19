// The ratchet's reading of git, in a throwaway repository: a base before the list, one with it, a
// ref that isn't there, and a listed file renamed since.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Git, LIST, baseList, renamesSince } from "./rust-daemon.ts";

let repo: string;

function env(): NodeJS.ProcessEnv {
  const clean = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
  );
  return { ...clean, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };
}

const inRepo: Git = (args) => {
  const run = spawnSync("git", args, { cwd: repo, env: env(), encoding: "utf8" });
  return { status: run.status, stdout: run.stdout };
};

const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: repo, env: env(), encoding: "utf8" }).trim();

function commit(files: Record<string, string>, message: string): string {
  for (const [file, text] of Object.entries(files)) {
    mkdirSync(join(repo, file, ".."), { recursive: true });
    writeFileSync(join(repo, file), text);
  }
  git("add", ...Object.keys(files));
  git("commit", "--quiet", "-m", message);
  return git("rev-parse", "HEAD");
}

const BODY = 'import { it } from "vitest";\n\nit("answers", () => {});\n'.repeat(8);

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), "bz-fixture-rust-daemon-")));
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Ratchet Test");
  git("config", "user.email", "ratchet@example.com");
});

afterEach(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("the base's list, read from git", () => {
  it("is the list at a commit that has one, and nothing at one from before it", () => {
    const before = commit({ "README.md": "x\n" }, "before");
    const after = commit({ [LIST]: "# both\ntests/api/a.test.ts\n" }, "list");
    expect([baseList(before, inRepo), baseList(after, inRepo)]).toEqual([
      [],
      ["tests/api/a.test.ts"],
    ]);
  });

  it("is an error at a ref the repository doesn't have", () => {
    commit({ [LIST]: "tests/api/a.test.ts\n" }, "list");
    expect(baseList("origin/main", inRepo)).toEqual({
      error: "the base origin/main isn't a commit here: fetch it, or name another",
    });
  });
});

describe("renames since the base, read from git", () => {
  it("maps each api test file git sees renamed to its new name, and nothing else", () => {
    const base = commit(
      { "tests/api/old.test.ts": BODY, "tests/api/kept.test.ts": "kept\n", "other/x.ts": BODY },
      "base",
    );
    git("mv", "tests/api/old.test.ts", "tests/api/new.test.ts");
    git("mv", "other/x.ts", "other/y.ts");
    git("commit", "--quiet", "-m", "rename");
    expect(renamesSince(base, inRepo)).toEqual(
      new Map([["tests/api/old.test.ts", "tests/api/new.test.ts"]]),
    );
  });
});

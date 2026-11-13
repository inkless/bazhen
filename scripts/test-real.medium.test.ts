// What pnpm test:real puts over HEAD in its build context, read from a throwaway repository with
// changes staged, unstaged, deleted, renamed and untracked.

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildContext, isInside, overlay } from "./test-real.ts";

const ODD = "odd dir/a\nb.ts";
const CHANGED = ["added.ts", "new.ts", ODD, "staged.ts", "unstaged.ts", "untracked/u.ts"];
/** Deleted or renamed away, then ignored and secret. */
const GONE = ["deleted.ts", "old.ts", "staged-gone.ts", "ignored.ts", ".env"];

const contents = (root: string, files: readonly string[]) =>
  Object.fromEntries(files.map((file) => [file, readFileSync(join(root, file), "utf8")]));

let repo: string;
const dirs: string[] = [];
const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
const write = (file: string, text: string) => {
  mkdirSync(dirname(join(repo, file)), { recursive: true });
  writeFileSync(join(repo, file), text);
};

beforeEach(() => {
  // Neither the user's git config nor a hook's git environment reaches these repositories.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  for (const name of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) vi.stubEnv(name, undefined);
  repo = mkdtempSync(join(tmpdir(), "bz-overlay-"));
  dirs.push(repo);
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  for (const file of ["staged.ts", "unstaged.ts", "deleted.ts", "staged-gone.ts", "old.ts", ODD]) {
    write(file, `${file} at HEAD\n`);
  }
  write(".gitignore", "ignored.ts\n");
  git("add", "--all");
  git("commit", "--quiet", "--message", "base");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Every kind of change the worktree can hold against HEAD. */
function change(): void {
  write("staged.ts", "staged\n");
  git("add", "staged.ts");
  write("unstaged.ts", "unstaged\n");
  rmSync(join(repo, "deleted.ts"));
  git("rm", "--quiet", "staged-gone.ts");
  git("mv", "old.ts", "new.ts");
  write("added.ts", "added and staged\n");
  git("add", "added.ts");
  write(ODD, "odd\n");
  write("untracked/u.ts", "untracked\n");
  write("ignored.ts", "ignored\n");
  write(".env", "SECRET=1\n");
}

describe("test:real's overlay", () => {
  it("is empty for a worktree that matches HEAD", () => {
    expect(overlay(repo)).toEqual({ copy: [], remove: [], skipped: [] });
  });

  it("copies what is staged or not, removes what is deleted or renamed away", () => {
    change();
    const { copy, remove, skipped } = overlay(repo);
    expect(copy.toSorted()).toEqual(CHANGED.toSorted());
    expect(remove.toSorted()).toEqual(GONE.slice(0, 3));
    expect(skipped).toEqual([".env"]);
  });

  it("builds a context whose files are the worktree's, not HEAD's", () => {
    change();
    const context = buildContext(repo, "HEAD", "bz-overlay-context-");
    dirs.push(context);
    expect(contents(context, CHANGED)).toEqual(contents(repo, CHANGED));
    expect(GONE.filter((file) => existsSync(join(context, file)))).toEqual([]);
  });

  it("removes a tracked directory's files when a symlink replaced it, and copies links as links", () => {
    const outside = mkdtempSync(join(tmpdir(), "bz-overlay-outside-"));
    dirs.push(outside);
    writeFileSync(join(outside, "x.ts"), "outside\n");
    write("d/x.ts", "inside\n");
    git("add", "d/x.ts");
    git("commit", "--quiet", "--message", "d");
    rmSync(join(repo, "d"), { recursive: true });
    symlinkSync(outside, join(repo, "d"));
    symlinkSync(join(outside, "x.ts"), join(repo, "f.ts"));
    expect(overlay(repo)).toEqual({ copy: ["d", "f.ts"], remove: ["d/x.ts"], skipped: [] });
    const context = buildContext(repo, "HEAD", "bz-overlay-context-");
    dirs.push(context);
    expect(lstatSync(join(context, "d")).isSymbolicLink()).toBe(true);
    expect(lstatSync(join(context, "f.ts")).isSymbolicLink()).toBe(true);
  });

  it("tells a file whose directory resolves outside the repository from one inside", () => {
    const outside = mkdtempSync(join(tmpdir(), "bz-overlay-outside-"));
    dirs.push(outside);
    symlinkSync(outside, join(repo, "link"));
    mkdirSync(join(repo, "..sneaky"));
    expect(isInside(repo, "staged.ts")).toBe(true);
    expect(isInside(repo, "odd dir/x.ts")).toBe(true);
    expect(isInside(repo, "..sneaky/x.ts")).toBe(true);
    expect(isInside(repo, "link/x.ts")).toBe(false);
  });
});

import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensurePrivateDir, UnsafeRuntimeDir } from "./private-dir.ts";

const uid = userInfo().uid;
let root = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bz-private-dir-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;

describe("ensurePrivateDir", () => {
  it("creates the directory readable by this user only", () => {
    const run = join(root, "a", "run");
    ensurePrivateDir(run, uid);
    expect(mode(run)).toBe(0o700);
  });

  it("tightens an existing directory this user owns", () => {
    const run = join(root, "run");
    ensurePrivateDir(run, uid);
    chmodSync(run, 0o755);
    ensurePrivateDir(run, uid);
    expect(mode(run)).toBe(0o700);
  });

  it("refuses a directory owned by someone else", () => {
    const run = join(root, "run");
    expect(() => ensurePrivateDir(run, uid + 1)).toThrow(UnsafeRuntimeDir);
  });

  it("refuses a symlink, which could point the socket anywhere", () => {
    const target = join(root, "elsewhere");
    ensurePrivateDir(target, uid);
    symlinkSync(target, join(root, "run"));
    expect(() => ensurePrivateDir(join(root, "run"), uid)).toThrow(/symlink/);
  });

  it("refuses a file in the directory's place", () => {
    writeFileSync(join(root, "run"), "");
    expect(() => ensurePrivateDir(join(root, "run"), uid)).toThrow(UnsafeRuntimeDir);
  });
});

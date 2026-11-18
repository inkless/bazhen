import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentCli } from "./agent-cli.ts";

let root = "";
let built = "";
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "bz-agent-cli-")));
  built = join(root, "target", "release", "bazhen");
  mkdirSync(join(root, "target", "release"), { recursive: true });
  writeFileSync(built, "#!/bin/sh\n");
  chmodSync(built, 0o755);
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const dir = (name: string) => {
  const path = join(root, name);
  mkdirSync(path);
  return path;
};

describe("the bazhen agents find on their PATH", () => {
  it("is the daemon's build when a link on the PATH points at it", () => {
    const bin = dir("bin");
    symlinkSync(built, join(bin, "bazhen"));
    expect(agentCli({ PATH: `/usr/nonexistent:${bin}` }, built)).toEqual({
      expected: built,
      onPath: built,
    });
  });

  it("reads a leading ~ in a PATH entry as the captured HOME, as bash does", () => {
    const bin = dir("bin");
    symlinkSync(built, join(bin, "bazhen"));
    expect(agentCli({ PATH: "~/bin", HOME: root }, built).onPath).toBe(built);
    expect(agentCli({ PATH: "~/bin" }, built).onPath).toBeNull();
    expect(agentCli({ PATH: "~/bin", HOME: "home" }, built).onPath).toBeNull();
  });

  it("is another build when the PATH holds a copy", () => {
    const bin = dir("bin");
    copyFileSync(built, join(bin, "bazhen"));
    expect(agentCli({ PATH: bin }, built)).toEqual({
      expected: built,
      onPath: join(bin, "bazhen"),
    });
  });

  it("is the first of two on the PATH, as a shell finds it", () => {
    const first = dir("first");
    const second = dir("second");
    copyFileSync(built, join(first, "bazhen"));
    symlinkSync(built, join(second, "bazhen"));
    expect(agentCli({ PATH: `${first}:${second}` }, built).onPath).toBe(join(first, "bazhen"));
  });

  it("skips what a shell would: a file that can't run, a dangling link, a directory", () => {
    const plain = dir("plain");
    writeFileSync(join(plain, "bazhen"), "");
    chmodSync(join(plain, "bazhen"), 0o644);
    const dangling = dir("dangling");
    symlinkSync(join(root, "missing"), join(dangling, "bazhen"));
    const folder = dir("folder");
    mkdirSync(join(folder, "bazhen"));
    const good = dir("good");
    symlinkSync(built, join(good, "bazhen"));
    expect(agentCli({ PATH: [plain, dangling, folder, good].join(":") }, built).onPath).toBe(built);
  });

  it("is none when the PATH is unset, empty, relative or holds no bazhen", () => {
    const bin = dir("bin");
    symlinkSync(built, join(bin, "bazhen"));
    for (const env of [
      {},
      { PATH: "" },
      { PATH: relative(process.cwd(), bin) },
      { PATH: dir("empty") },
    ])
      expect(agentCli(env, built).onPath).toBeNull();
  });

  it("says no build is beside the daemon when none was built", () => {
    expect(agentCli({ PATH: "" }, join(root, "missing"))).toEqual({
      expected: null,
      onPath: null,
    });
  });
});

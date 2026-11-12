import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { TmuxServer } from "./tmux.ts";

const uid = process.getuid?.() ?? 0;
const made: string[] = [];
const saved = process.env["TMUX_TMPDIR"];
afterEach(() => {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
  process.env["TMUX_TMPDIR"] = saved;
});
const tempDir = () => {
  const dir = mkdtempSync("/tmp/bz-guard-");
  made.push(dir);
  return dir;
};

describe("the tmux socket guard, on the file system", () => {
  it("names a server by its root's real path, and never runs tmux to do it", () => {
    const dir = tempDir();
    const link = `${dir}-link`;
    symlinkSync(dir, link);
    made.push(link);
    const server = TmuxServer.at(join(link, "s"), { root: link, config: "/dev/null" });
    expect(server.socket).toBe(join(realpathSync(dir), "s"));
    expect(server.argv("list-sessions")).toEqual([
      "tmux",
      "-u",
      "-S",
      join(realpathSync(dir), "s"),
      "-f",
      "/dev/null",
      "list-sessions",
    ]);
  });

  it("refuses a root that is missing, or open to other users", () => {
    const dir = tempDir();
    expect(() => TmuxServer.at(join(dir, "gone", "s"), { root: join(dir, "gone") })).toThrow(
      "does not exist",
    );
    chmodSync(dir, 0o755);
    expect(() => TmuxServer.at(join(dir, "s"), { root: dir })).toThrow("open to other users");
  });

  it("refuses a root that resolves into TMUX_TMPDIR's shared directory", () => {
    const tmpdir = tempDir();
    const shared = join(tmpdir, `tmux-${uid}`);
    mkdirSync(shared, { mode: 0o700 });
    const link = join(tempDir(), "root");
    symlinkSync(shared, link);
    process.env["TMUX_TMPDIR"] = tmpdir;
    expect(() => TmuxServer.at(join(link, "s"), { root: link })).toThrow("own servers live");
  });
});

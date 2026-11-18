import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

/** How a Node process run with `args` ended: its exit code, and what it printed. */
const runNode = (args: string[]) =>
  new Promise<{ code: number | null; out: string; err: string }>((done) => {
    execFile(process.execPath, args, { encoding: "utf8" }, (error, out, err) =>
      done({ code: error === null ? 0 : Number(error.code), out, err }),
    );
  });

describe("a tmux that exits before it reads the script it was given", () => {
  it("settles by its exit, and its broken stdin ends nothing", async () => {
    const dir = tempDir();
    const bin = join(dir, "bin");
    mkdirSync(bin);
    // A stand-in that reaches no server: it exits at once and never reads its stdin.
    writeFileSync(join(bin, "tmux"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    // In a process of its own, since an unheard broken pipe ends the process it happens in.
    // The script is far past a socketpair's buffer, so its write is still pending at the exit.
    const caller = `
      import { TmuxServer } from ${JSON.stringify(fileURLToPath(new URL("tmux.ts", import.meta.url)))};
      const [socket, root, path] = process.argv.slice(1);
      const set = Object.fromEntries(
        Array.from({ length: 20_000 }, (_, i) => ["BZ_PAD_" + i, "x".repeat(64)]),
      );
      await TmuxServer.at(socket, { root }).setEnvironment(set, [], { env: { PATH: path } });
      console.log("settled");
    `;
    const ran = await runNode(["--input-type=module", "-e", caller, join(dir, "s"), dir, bin]);
    expect(ran).toMatchObject({ code: 0, out: "settled\n" });
  });
});

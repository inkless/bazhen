import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const repo = fileURLToPath(new URL("..", import.meta.url));
const dir = mkdtempSync(join(tmpdir(), "bz-lint-plugin-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The lines oxlint reports under `bazhen(host-guard)` in `source`, linted with the repo's config. */
function flagged(source: string): number[] {
  const file = join(dir, "fixture.ts");
  writeFileSync(file, source);
  let out = "";
  try {
    execFileSync(
      join(repo, "node_modules/.bin/oxlint"),
      ["-c", join(repo, ".oxlintrc.json"), "-f", "unix", file],
      {
        cwd: repo,
        encoding: "utf8",
      },
    );
  } catch (error) {
    out = String(Reflect.get(Object(error), "stdout"));
  }
  return [...out.matchAll(/fixture\.ts:(\d+):\d+: .*host-guard/g)].map((m) => Number(m[1]));
}

const FIXTURE = [
  'import { execFileSync, execSync, spawn } from "node:child_process";',
  'import { spawn as launch, execFile } from "node:child_process";',
  'import * as cp from "node:child_process";',
  'import { kill } from "node:process";',
  'import { promisify } from "node:util";',
  "declare const pty: { spawn(argv: string[]): void };",
  "declare const z: { literal(v: string): unknown };",
  "declare const describe: (name: string) => void;",
  "const run = promisify(execFile);",
  'const bin = "tmux";',
  'const argv = ["/usr/bin/tmux", "kill-server"];',
  'execFileSync("tmux", ["-L", "default", "kill-server"]);',
  'pty.spawn(["tmux", "attach-session"]);',
  'void run("tmux", ["list-sessions"]);',
  "execSync(`tmux kill-server`);",
  'spawn("tmux -L default kill-server");',
  'process.kill(-1, "SIGKILL");',
  'process["kill"](1, "SIGTERM");',
  'launch("tmux", []);',
  'execFileSync("/usr/bin/tmux", ["kill-server"]);',
  'execFileSync("sh", ["-c", "tmux kill-server"]);',
  'execFileSync("env", ["tmux", "kill-server"]);',
  'execFileSync(bin, ["kill-server"]);',
  'spawn(argv[0] ?? "", []); execFileSync("x", argv);',
  'execFileSync.call(null, "tmux", ["kill-server"]);',
  'cp.execFileSync("tmux", ["kill-server"]);',
  'globalThis.process.kill(1, "SIGTERM");',
  "const { kill: stop } = process;",
  'execFileSync("git", ["status"]);',
  'execFileSync("tmuxinator", []);',
  'z.literal("tmux");',
  'describe("tmux runtime on a private server");',
  "void new Error(`tmux ${bin} failed`);",
  "void [kill, stop];",
  "declare const linuxNotifier: (binary: string) => void;",
  'linuxNotifier("/usr/bin/tmux");',
  'linuxNotifier("/usr/bin/notify-send");',
  "declare const spawnGroup: (command: string, args: string[]) => void;",
  'spawnGroup("tmux", ["kill-server"]);',
].join("\n");

describe("the host-guard lint rule", () => {
  it("flags every tmux command and signal outside host-guard, a notifier or a process group pointed at tmux included, and nothing that only names tmux", () => {
    expect(flagged(FIXTURE)).toEqual([
      4, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 36, 39,
    ]);
  });
});

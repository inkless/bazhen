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

const FIXTURE = `import { execFileSync, execSync, spawn } from "node:child_process";
declare const pty: { spawn(argv: string[]): void };
declare const run: (cmd: string, args: string[]) => Promise<unknown>;
declare const z: { literal(v: string): unknown };
declare const describe: (name: string) => void;
execFileSync("tmux", ["-L", "default", "kill-server"]);
pty.spawn(["tmux", "attach-session"]);
void run("tmux", ["list-sessions"]);
execSync(\`tmux kill-server\`);
spawn("tmux -L default kill-server");
process.kill(-1, "SIGKILL");
process["kill"](1, "SIGTERM");
execFileSync("git", ["status"]);
execFileSync("tmuxinator", []);
z.literal("tmux");
describe("tmux runtime on a private server");
`;

describe("the host-guard lint rule", () => {
  it("flags every tmux command and signal outside host-guard, and nothing that only names tmux", () => {
    expect(flagged(FIXTURE)).toEqual([6, 7, 8, 9, 10, 11, 12]);
  });
});

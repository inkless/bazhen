// Vitest globalSetup for the medium project, which runs on the host in `pnpm check`. Medium tests
// never run tmux. Should one gain a tmux command by mistake, it still finds an empty socket
// directory of its own and no TMUX, so it can only start a throwaway server, never reach one.
// BAZHEN_HOME is temporary, so no test touches the user's real data.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];

export function setup(): void {
  const tmuxDir = mkdtempSync("/tmp/bz-tmux-");
  made.push(tmuxDir);
  process.env["TMUX_TMPDIR"] = tmuxDir;
  delete process.env["TMUX"];
  delete process.env["TMUX_PANE"];
  const home = mkdtempSync(join(tmpdir(), "bz-test-home-"));
  made.push(home);
  process.env["BAZHEN_HOME"] = home;
}

export function teardown(): void {
  for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true });
}

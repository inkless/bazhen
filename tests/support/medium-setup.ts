// Vitest globalSetup for the medium project, which runs on the host in `moon run :check`. Medium
// tests never run tmux. Should one gain a tmux command by mistake, it still finds an empty socket
// directory of its own and no TMUX, so it can only start a throwaway server, never reach one.
// BAZHEN_HOME is temporary, so no test touches the user's real data.
//
// TMPDIR is a directory of this run's own, so every directory a test makes under os.tmpdir() is
// removed with it, however the test ends, and a killed run leaves one entry in /tmp. It is under
// /tmp, not the caller's TMPDIR, so a Unix socket path in it stays short on macOS too. A test that
// names /tmp itself for that reason removes its own directory.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const made: string[] = [];
let outer: { tmpdir: string | undefined } | undefined;

export function setup(): void {
  const run = mkdtempSync("/tmp/bz-run-");
  made.push(run);
  outer = { tmpdir: process.env["TMPDIR"] };
  process.env["TMPDIR"] = run;
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
  if (outer === undefined) return;
  if (outer.tmpdir === undefined) delete process.env["TMPDIR"];
  else process.env["TMPDIR"] = outer.tmpdir;
  outer = undefined;
}

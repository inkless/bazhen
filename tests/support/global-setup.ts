// Vitest globalSetup for the integration and api projects (docs/standards/testing.md).
// - They run only on a disposable host (./disposable-host.ts). That check comes before anything
//   else, and teardown does nothing unless setup got past it, so a refused run executes no tmux.
// - Every run gets a temporary BAZHEN_HOME, so no test touches the user's real data.
// - Every run gets its own tmux socket directory (TMUX_TMPDIR) and runs outside any tmux client
//   (TMUX unset). Every tmux command a test runs, with or without -L, lands on a throwaway server
//   and can never reach the user's sessions, the agent fleet, or a real Bazhen daemon. That
//   isolation comes next, before anything in setup that can fail, because teardown runs even
//   when setup failed. Teardown looks only in the directory this run made, never at
//   TMUX_TMPDIR or /tmp, and never kills a server named `default`; it fails the run if any
//   server there is still alive.
// - The run refuses to start when the machine is close to running out of PTYs: a leak there
//   starves every terminal on the machine, not just Bazhen's.

import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TmuxServer } from "@bazhen/host-guard";
import { requireDisposableHost } from "./disposable-host.ts";
import { requirePtyHeadroom } from "./ptys.ts";

// Under /tmp, not os.tmpdir(): a Unix socket path must fit in about 104 bytes on macOS, and the
// per-user temp directory there is already over 50.
function privateTmuxDir(): string {
  return mkdtempSync("/tmp/bz-tmux-");
}

// Vitest's source-map lookup crashes on errors thrown from globalSetup and hides their message,
// so print it before throwing.
function fail(message: string): never {
  console.error(`\n${message}\n`);
  throw new Error(message);
}

/**
 * A run's two directories: `servers`, the root its tests' servers live in, and `stray`, its
 * TMUX_TMPDIR, where a bare `tmux` would land. They are siblings, because host-guard refuses a
 * root that holds TMUX_TMPDIR's `tmux-<uid>`.
 */
const socketDir = (dir: string) => join(dir, "servers");
const strayDir = (dir: string) => join(dir, "stray");

/** The live tmux servers in a run's own socket directory. */
function serversIn(dir: string): Map<string, TmuxServer> {
  const servers = new Map<string, TmuxServer>();
  for (const name of readdirSync(socketDir(dir))) {
    // `default` is refused even here: killing one by mistake ends every session on the machine.
    if (name === "default") continue;
    const path = join(socketDir(dir), name);
    // The servers' config files sit beside their sockets.
    if (!statSync(path).isSocket()) continue;
    const server = TmuxServer.at(path, { root: socketDir(dir) });
    if (server.alive()) servers.set(name, server);
  }
  return servers;
}

let home: string | undefined;
let tmuxDir: string | undefined;

export function setup(): void {
  requireDisposableHost();
  // Next, before anything that can fail: teardown runs even after a failed setup.
  tmuxDir = privateTmuxDir();
  mkdirSync(socketDir(tmuxDir), { mode: 0o700 });
  mkdirSync(strayDir(tmuxDir), { mode: 0o700 });
  process.env["TMUX_TMPDIR"] = strayDir(tmuxDir);
  process.env["BZ_TEST_SERVERS"] = socketDir(tmuxDir);
  delete process.env["TMUX"];
  delete process.env["TMUX_PANE"];
  requirePtyHeadroom();
  home = mkdtempSync(join(tmpdir(), "bz-test-home-"));
  process.env["BAZHEN_HOME"] = home;
  process.env["BZ_TEST_RUN"] = `${process.pid}`;
}

export function teardown(): void {
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
  const dir = tmuxDir;
  tmuxDir = undefined;
  // Setup never made this run's directory, so no server is this run's to stop.
  if (dir === undefined) return;
  const leaked = serversIn(dir);
  for (const server of leaked.values()) server.kill();
  rmSync(dir, { recursive: true, force: true });
  if (leaked.size > 0) {
    fail(
      `Tests left ${leaked.size} tmux server(s) running: ${[...leaked.keys()].join(", ")}. ` +
        "Kill every server a test starts in afterAll (docs/standards/testing.md).",
    );
  }
}

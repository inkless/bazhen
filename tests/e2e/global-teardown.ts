import { rmSync } from "node:fs";
import { join } from "node:path";
import { TmuxServer } from "@bazhen/host-guard";
import { onDisposableHost } from "../support/disposable-host.ts";

// Kills this run's private tmux server and removes its temporary home. Playwright has stopped
// the daemon by now, but tmux deliberately outlives it.
export default function teardown(): void {
  // The config refused to start the run, so nothing here is this run's.
  if (!onDisposableHost()) return;
  const home = process.env["BZ_E2E_HOME"];
  // The daemon's server, by its socket in the run's own home: run/tmux.sock, for a home this short.
  if (home) TmuxServer.at(join(home, "run", "tmux.sock"), { root: home }).kill();
  const tmuxDir = process.env["BZ_E2E_TMUX_TMPDIR"];
  if (tmuxDir) rmSync(tmuxDir, { recursive: true, force: true });
  // An agent's process may still be writing its state as the tmux server goes down.
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

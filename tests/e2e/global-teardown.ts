import { rmSync } from "node:fs";
import { join } from "node:path";
import { TmuxServer } from "@bazhen/host-guard";
import { closeHoldersUnder } from "../support/holder-close.ts";
import { onDisposableHost } from "../support/disposable-host.ts";
import { daemonHome, RUNTIMES } from "./daemons.ts";

// Ends what each daemon left running, then removes the run's directory. Playwright has stopped the
// daemons by now, but tmux and holders deliberately outlive them.
export default async function teardown(): Promise<void> {
  // The config refused to start the run, so nothing here is this run's.
  if (!onDisposableHost()) return;
  const root = process.env["BZ_E2E_ROOT"];
  if (root) {
    const homes = RUNTIMES.map(daemonHome);
    // Before tmux, so a refused socket below can't leave holders running.
    await Promise.all(homes.map(closeHoldersUnder));
    // Each daemon's own server, by its socket in its home: run/tmux.sock, for a home this short.
    for (const home of homes) {
      TmuxServer.at(join(home, "run", "tmux.sock"), { root: home }).killServer();
    }
  }
  const tmuxDir = process.env["BZ_E2E_TMUX_TMPDIR"];
  if (tmuxDir) rmSync(tmuxDir, { recursive: true, force: true });
  // An agent's process may still be writing its state as its terminal goes down.
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

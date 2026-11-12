import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { onDisposableHost } from "../support/disposable-host.ts";

// Kills this run's private tmux server and removes its temporary home. Playwright has stopped
// the daemon by now, but tmux deliberately outlives it.
export default function teardown(): void {
  // The config refused to start the run, so nothing here is this run's.
  if (!onDisposableHost()) return;
  const socket = process.env["BZ_E2E_SOCKET"];
  const tmuxDir = process.env["BZ_E2E_TMUX_TMPDIR"];
  // Only by path in the run's own socket directory, so it can't reach any other server.
  if (socket && socket !== "default" && tmuxDir) {
    const path = join(tmuxDir, `tmux-${process.getuid?.() ?? 0}`, socket);
    try {
      execFileSync("tmux", ["-S", path, "kill-server"], { stdio: "ignore", timeout: 5000 });
    } catch {
      // The run never started a terminal.
    }
  }
  if (tmuxDir) rmSync(tmuxDir, { recursive: true, force: true });
  const home = process.env["BZ_E2E_HOME"];
  // An agent's process may still be writing its state as the tmux server goes down.
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

// Kills this run's private tmux server and removes its temporary home. Playwright has stopped
// the daemon by now, but tmux deliberately outlives it.
export default function teardown(): void {
  const socket = process.env["BZ_E2E_SOCKET"];
  if (socket) {
    try {
      execFileSync("tmux", ["-L", socket, "kill-server"], { stdio: "ignore", timeout: 5000 });
    } catch {
      // The run never started a terminal.
    }
  }
  const home = process.env["BZ_E2E_HOME"];
  // An agent's process may still be writing its state as the tmux server goes down.
  if (home) rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

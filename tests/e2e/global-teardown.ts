import { rmSync } from "node:fs";
import { join } from "node:path";
import { TmuxServer } from "@bazhen/host-guard";
import { closeHoldersUnder } from "../support/holder-close.ts";
import { onDisposableHost } from "../support/disposable-host.ts";
import { homeOf, RUNTIMES, stopDaemon } from "./daemons.ts";

// Ends what each daemon started, then removes the run's directory. Playwright stops its web servers
// only after this, and tmux and holders outlive their daemon by design. Each step runs whatever an
// earlier one threw, so one refusal can't leave the rest running; the errors are thrown at the end.
export default async function teardown(): Promise<void> {
  // The config refused to start the run, so nothing here is this run's.
  if (!onDisposableHost()) return;
  const errors: unknown[] = [];
  const attempt = async (step: () => unknown) => {
    try {
      await step();
    } catch (error) {
      errors.push(error);
    }
  };
  const root = process.env["BZ_E2E_ROOT"];
  if (root) {
    const homes = RUNTIMES.map(homeOf);
    await Promise.all(homes.map((home) => attempt(() => stopDaemon(home))));
    await Promise.all(homes.map((home) => attempt(() => closeHoldersUnder(home))));
    for (const home of homes) {
      // The daemon's own server, by its socket in its home: run/tmux.sock, for a home this short.
      await attempt(() =>
        TmuxServer.at(join(home, "run", "tmux.sock"), { root: home }).killServer(),
      );
    }
  }
  const tmuxDir = process.env["BZ_E2E_TMUX_TMPDIR"];
  if (tmuxDir) rmSync(tmuxDir, { recursive: true, force: true });
  // An agent's process may still be writing its state as its terminal goes down.
  if (root) rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  if (errors.length > 0) throw new AggregateError(errors, "e2e teardown left something running");
}

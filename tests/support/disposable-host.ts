// Real-tmux suites start tmux servers, real PTYs and real agent CLIs. On a machine someone works
// on, one wrong socket ends every tmux session they have, so those suites run only on a host that
// exists to be thrown away: the test container, or a CI runner. A host qualifies by a root-owned
// marker file, never by an environment variable, which any agent sets out of habit
// (packages/host-guard/src/sandbox.ts).

import {
  DISPOSABLE_HOST_MARKER,
  type SandboxHost,
  inSignalSandbox,
  thisHost,
} from "@bazhen/host-guard";
import { failSetup } from "./setup-error.ts";

export { DISPOSABLE_HOST_MARKER };

export function onDisposableHost(
  platform: NodeJS.Platform = process.platform,
  host: SandboxHost = thisHost(),
): boolean {
  return platform === "linux" && inSignalSandbox(host);
}

/** Throws unless this is a disposable host; first in every real-tmux suite's setup. */
export function requireDisposableHost(host = onDisposableHost()): void {
  if (host) return;
  const message =
    "Refusing to run: these tests start real tmux servers and agent processes, and run only " +
    `in the test container (pnpm test:real) or CI, on a Linux host carrying a root-owned ` +
    `${DISPOSABLE_HOST_MARKER}. Never create that file on a machine you work on.`;
  failSetup(message);
}

// Real-tmux suites start tmux servers, real PTYs and real agent CLIs. On a machine someone works
// on, one wrong socket ends every tmux session they have, so those suites run only on a host that
// exists to be thrown away: the test container, or a CI runner. A host qualifies by a root-owned
// marker file, never by an environment variable, which any agent sets out of habit
// (packages/host-guard/src/sandbox.ts). The holder suite runs only there too: a holder that
// closes signals every process in its session.

import {
  DISPOSABLE_HOST_MARKER,
  SANDBOX_RULE,
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
    `in the test container (moon run :test-real) or CI, on a Linux host carrying a root-owned ` +
    `${DISPOSABLE_HOST_MARKER}. Never create that file on a machine you work on.`;
  failSetup(message);
}

/**
 * Throws unless this is a disposable host, on any platform; first wherever the holder suite
 * could start or end a holder: its setup, its ledger sweep and its process starts.
 */
export function requireSignalSandbox(sandboxed = inSignalSandbox()): void {
  if (sandboxed) return;
  failSetup(
    "Refusing to run: the holder tests start holders, which signal every process in their " +
      `sessions when they close, and ${SANDBOX_RULE}. Run them with moon run :test-real -- holder.`,
  );
}

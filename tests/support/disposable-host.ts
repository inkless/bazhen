// Real-tmux suites start tmux servers, real PTYs and real agent CLIs. On a machine someone works
// on, one wrong socket ends every tmux session they have, so those suites run only on a host that
// exists to be thrown away: the test container, or a CI runner. A host qualifies by a root-owned
// marker file, never by an environment variable, which any agent sets out of habit.

import { existsSync } from "node:fs";

export const DISPOSABLE_HOST_MARKER = "/etc/bazhen-disposable-host";

export function onDisposableHost(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): boolean {
  return platform === "linux" && exists(DISPOSABLE_HOST_MARKER);
}

/** Throws unless this is a disposable host; first in every real-tmux suite's setup. */
export function requireDisposableHost(host = onDisposableHost()): void {
  if (host) return;
  const message =
    "Refusing to run: these tests start real tmux servers and agent processes, and run only " +
    `in the test container (pnpm test:real) or CI, on a Linux host carrying ` +
    `${DISPOSABLE_HOST_MARKER}. Never create that file on a machine you work on.`;
  // Vitest's source-map lookup hides errors thrown from globalSetup, so print it as well.
  console.error(`\n${message}\n`);
  throw new Error(message);
}

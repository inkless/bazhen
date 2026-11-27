// Whether this host exists to be thrown away: the test container or a CI runner, each of which
// carries a root-owned marker. Only there may a test signal processes it didn't start, or run
// real tmux. Never a PID namespace alone: Flatpak terminals, devcontainers, LXD and WSL2 are
// workstations in one, and a stray kill(-1) there still ends the developer's own processes.
// Only Node built-ins, so scripts can import it by path (scripts/signal-paths.ts).

import { lstatSync } from "node:fs";

/** Marks a host that exists to be thrown away: the test container, or a CI runner. */
export const DISPOSABLE_HOST_MARKER = "/etc/bazhen-disposable-host";

/** What decides whether a host is disposable: who owns its marker. */
export interface SandboxHost {
  /** The marker's owner, if it is a file and not a link; undefined if it isn't there. */
  readonly markerOwner: number | undefined;
}

/** This host, as `inSignalSandbox` reads it, from the marker at `marker`. */
export function thisHost(marker = DISPOSABLE_HOST_MARKER): SandboxHost {
  try {
    const stat = lstatSync(marker);
    return { markerOwner: stat.isFile() ? stat.uid : undefined };
  } catch {
    return { markerOwner: undefined };
  }
}

/** Whether a test may signal processes it didn't start: the marker is there, and root's. */
export const inSignalSandbox = (host: SandboxHost = thisHost()) => host.markerOwner === 0;

/** Why a signalling test won't run here, and where it does. */
export const SANDBOX_RULE =
  "such a test signals processes it didn't start, so it runs only on a host that exists to be " +
  "thrown away: the test container (make test-real) or a CI runner, each carrying a root-owned " +
  `${DISPOSABLE_HOST_MARKER}. Never create that file on a machine you work on`;

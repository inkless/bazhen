// How many PTYs the machine has in use, against the cutoff every suite that opens real PTYs
// refuses to start above (docs/standards/testing.md).

import { hostPtyReader } from "@bazhen/host-guard";
import { failSetup } from "./setup-error.ts";

// The spikes' watchdog aborted above 420 of macOS's 511 PTYs (kern.tty.ptmx_max).
const MACOS_CUTOFF = 420;
const LINUX_CUTOFF_FRACTION = 420 / 511;

function cutoffOverride(): number | undefined {
  const raw = process.env["BZ_PTY_CUTOFF"];
  if (raw === undefined || raw === "") return undefined;
  const cutoff = Number(raw);
  if (!Number.isFinite(cutoff) || cutoff <= 0) {
    failSetup(`BZ_PTY_CUTOFF must be a positive number of PTYs, got "${raw}".`);
  }
  return cutoff;
}

export function ptysInUse(): { used: number; cutoff: number } {
  const override = cutoffOverride();
  const host = hostPtyReader()();
  if (!host.ok) failSetup(`Refusing to run: the machine's PTYs can't be counted (${host.reason}).`);
  const cutoff =
    process.platform === "linux" ? Math.floor(host.max * LINUX_CUTOFF_FRACTION) : MACOS_CUTOFF;
  return { used: host.used, cutoff: override ?? cutoff };
}

/** Throws, first in a suite's setup, when the machine is too short of PTYs to run it. */
export function requirePtyHeadroom(): void {
  const { used, cutoff } = ptysInUse();
  if (used > cutoff) {
    failSetup(
      `Refusing to run: ${used} PTYs are in use machine-wide (cutoff ${cutoff}). ` +
        "Something is leaking PTYs; see the bz-debug-integration-test skill.",
    );
  }
}

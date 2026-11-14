// How many PTYs the machine has in use, against the cutoff every suite that opens real PTYs
// refuses to start above (docs/standards/testing.md).

import { readdirSync, readFileSync } from "node:fs";

// The spikes' watchdog aborted above 420 of macOS's 511 PTYs (kern.tty.ptmx_max).
const MACOS_CUTOFF = 420;
const LINUX_CUTOFF_FRACTION = 420 / 511;

// Vitest's source-map lookup crashes on errors thrown from globalSetup and hides their message,
// so print it before throwing.
function refuse(message: string): never {
  console.error(`\n${message}\n`);
  throw new Error(message);
}

const readPtySysctl = (name: string) =>
  Number(readFileSync(`/proc/sys/kernel/pty/${name}`, "utf8").trim());

function cutoffOverride(): number | undefined {
  const raw = process.env["BZ_PTY_CUTOFF"];
  if (raw === undefined || raw === "") return undefined;
  const cutoff = Number(raw);
  if (!Number.isFinite(cutoff) || cutoff <= 0) {
    refuse(`BZ_PTY_CUTOFF must be a positive number of PTYs, got "${raw}".`);
  }
  return cutoff;
}

export function ptysInUse(): { used: number; cutoff: number } {
  const override = cutoffOverride();
  if (process.platform === "linux") {
    const max = readPtySysctl("max");
    return {
      used: readPtySysctl("nr"),
      cutoff: override ?? Math.floor(max * LINUX_CUTOFF_FRACTION),
    };
  }
  // Counts the 16 legacy BSD names too, which overcounts slightly: the safe direction, and the
  // same way the spike measured the cutoff.
  const used = readdirSync("/dev").filter((name) => name.startsWith("ttys")).length;
  return { used, cutoff: override ?? MACOS_CUTOFF };
}

/** Throws, first in a suite's setup, when the machine is too short of PTYs to run it. */
export function requirePtyHeadroom(): void {
  const { used, cutoff } = ptysInUse();
  if (used > cutoff) {
    refuse(
      `Refusing to run: ${used} PTYs are in use machine-wide (cutoff ${cutoff}). ` +
        "Something is leaking PTYs; see the bz-debug-integration-test skill.",
    );
  }
}

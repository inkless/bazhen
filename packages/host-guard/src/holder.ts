// Checks that a pid is still the `bazhen-holder` a holder test recorded, before signal.ts may
// kill it: a pid reused since by anything else is left alone.

import { basename } from "node:path";
import { type HolderProcess, vouchHolderProcess } from "./signal.ts";
import { type PsReading, readProcess, START_SKEW_S } from "./tmux.ts";

export const HOLDER_COMMAND = "bazhen-holder";

/**
 * A proof `killHolder` takes, if `ps` shows `holder.pid` as a `bazhen-holder` that started within
 * `START_SKEW_S` of `holder.start`; null for a pid with no process, an unreadable one, or one that
 * is something else now.
 */
export async function vouchHolder(
  holder: HolderProcess,
  read: (pid: number) => Promise<PsReading> = readProcess,
  now: () => number = Date.now,
): Promise<HolderProcess | null> {
  const reading = await read(holder.pid);
  if (typeof reading === "string") return null;
  if (basename(reading.comm) !== HOLDER_COMMAND) return null;
  if (Math.abs(reading.start - holder.start) > START_SKEW_S) return null;
  return vouchHolderProcess(holder, now());
}

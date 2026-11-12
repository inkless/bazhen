import { constants } from "node:os";
import type { ExitStatus } from "@bazhen/protocol";

// Node lists the canonical name before its aliases (SIGABRT before SIGIOT), so the first wins.
const SIGNAL_NAMES = new Map<number, string>();
for (const [name, n] of Object.entries(constants.signals))
  if (!SIGNAL_NAMES.has(n)) SIGNAL_NAMES.set(n, name);

/**
 * How a dead pane's process ended, from tmux's `pane_dead_status` and `pane_dead_signal`. tmux
 * names a signal `term`, `TERM` or `15` depending on the platform. It marks a pane dead when its
 * pty closes, which can be before it has reaped the process, and tmux 3.4 sometimes never reaps
 * it, so a death can be of unknown cause.
 */
export function exitStatus(status: string, signal: string): ExitStatus {
  if (status !== "") return { type: "exited", code: Number(status) };
  if (signal === "") return { type: "unknown" };
  const name = /^\d+$/.test(signal)
    ? (SIGNAL_NAMES.get(Number(signal)) ?? signal)
    : `SIG${signal.toUpperCase().replace(/^SIG/, "")}`;
  return { type: "signalled", signal: name };
}

/**
 * Holds back a death of unknown cause for `graceMs`, in case its cause arrives, so a fresh death
 * reads as still running instead of unknown. After the grace it reads unknown, which a later
 * reading may still replace with the cause: unknown may become known, never the other way.
 */
export class UnknownCause {
  private readonly graceMs: number;
  private firstSeen = new Map<string, number>();

  constructor(graceMs: number) {
    this.graceMs = graceMs;
  }

  /** Each terminal's exit as it should be reported now; call once per reading, with every terminal. */
  settle<T extends { readonly key: string; readonly exit: ExitStatus | null }>(
    rows: readonly T[],
    now: number,
  ): T[] {
    const firstSeen = new Map<string, number>();
    const settled = rows.map((row) => {
      if (row.exit?.type !== "unknown") return row;
      const since = this.firstSeen.get(row.key) ?? now;
      firstSeen.set(row.key, since);
      return now - since >= this.graceMs ? row : { ...row, exit: null };
    });
    this.firstSeen = firstSeen;
    return settled;
  }
}

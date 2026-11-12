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

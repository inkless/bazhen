import type { TerminalState } from "@bazhen/protocol";
import { machine } from "./machine.ts";

export type TerminalEvent =
  | "runtime.confirmed"
  | "runtime.rejected"
  | "process.exited"
  | "runtime.unreachable"
  | "runtime.reconfirmed"
  | "target.absent"
  | "respawned"
  | "relinked"
  | "close.requested"
  | "close.completed";

// Only positive evidence that the runtime answers and the target is gone makes a terminal lost;
// an unreadable runtime keeps it unknown indefinitely (foundation-design §4.1).
export const terminal = machine<TerminalState, TerminalEvent>("terminal", {
  creating: { "runtime.confirmed": "running", "runtime.rejected": "failed" },
  running: {
    "process.exited": "exited",
    "runtime.unreachable": "unknown",
    "target.absent": "lost",
    relinked: "running",
    "close.requested": "closing",
  },
  unknown: {
    "runtime.reconfirmed": "running",
    "process.exited": "exited",
    "target.absent": "lost",
    relinked: "running",
    "close.requested": "closing",
  },
  exited: { respawned: "running", "target.absent": "lost", "close.requested": "closing" },
  lost: { "close.requested": "closing" },
  closing: { "close.completed": "closed" },
  closed: {},
  failed: {},
});

export interface TerminalPosition {
  readonly state: TerminalState;
  readonly generation: number;
}

/**
 * Applies `event` through the table. A respawn or a re-link starts a new runtime incarnation, so
 * it takes the next generation, and commands aimed at an older one are stale.
 */
export function advanceTerminal(at: TerminalPosition, event: TerminalEvent): TerminalPosition {
  const state = terminal.next(at.state, event);
  const incarnation = event === "respawned" || event === "relinked";
  return { state, generation: incarnation ? at.generation + 1 : at.generation };
}

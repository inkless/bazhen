import type { TerminalState } from "@bazhen/protocol";

export type TerminalEvent =
  | { type: "runtime.confirmed" }
  | { type: "runtime.rejected" }
  | { type: "process.exited" }
  | { type: "runtime.unreachable" }
  | { type: "runtime.reconfirmed" }
  | { type: "target.absent" }
  | { type: "respawned" }
  | { type: "close.requested" }
  | { type: "close.completed" };

const TRANSITIONS: Readonly<
  Record<TerminalState, Partial<Record<TerminalEvent["type"], TerminalState>>>
> = {
  creating: { "runtime.confirmed": "running", "runtime.rejected": "failed" },
  running: {
    "process.exited": "exited",
    "runtime.unreachable": "unknown",
    "target.absent": "lost",
    "close.requested": "closing",
  },
  // Only positive evidence that the runtime answers and the target is gone makes a terminal
  // lost; an unreadable runtime keeps it unknown indefinitely.
  unknown: { "runtime.reconfirmed": "running", "target.absent": "lost" },
  exited: { respawned: "running", "close.requested": "closing" },
  lost: { "close.requested": "closing" },
  closing: { "close.completed": "closed" },
  closed: {},
  failed: {},
};

export class InvalidTransition extends Error {
  readonly from: TerminalState;
  readonly event: TerminalEvent["type"];

  constructor(from: TerminalState, event: TerminalEvent["type"]) {
    super(`terminal cannot handle ${event} while ${from}`);
    this.from = from;
    this.event = event;
  }
}

export function nextState(from: TerminalState, event: TerminalEvent): TerminalState {
  const to = TRANSITIONS[from][event.type];
  if (to === undefined) throw new InvalidTransition(from, event.type);
  return to;
}

/** A respawn starts a new runtime incarnation; commands aimed at an older one are stale. */
export function nextGeneration(
  from: TerminalState,
  event: TerminalEvent,
  generation: number,
): number {
  return event.type === "respawned" && from === "exited" ? generation + 1 : generation;
}

export function isFinal(state: TerminalState): boolean {
  return state === "closed" || state === "failed";
}

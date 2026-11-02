// Property tests for the terminal state machine: invariants that must hold over every sequence
// of events, not just the hand-picked ones in terminal.test.ts. This is the pattern to copy for
// a state table (docs/standards/testing.md): a pure walk over random events at module scope, one
// predicate per invariant, and `fc.assert` in the test.

import * as fc from "fast-check";
import type { TerminalState } from "@bazhen/protocol";
import { describe, expect, it } from "vitest";
import {
  InvalidTransition,
  isFinal,
  nextGeneration,
  nextState,
  type TerminalEvent,
} from "./terminal.ts";

const EVENT_TYPES: TerminalEvent["type"][] = [
  "runtime.confirmed",
  "runtime.rejected",
  "process.exited",
  "runtime.unreachable",
  "runtime.reconfirmed",
  "target.absent",
  "respawned",
  "close.requested",
  "close.completed",
];

const events = fc.array(
  fc.constantFrom(...EVENT_TYPES).map((type): TerminalEvent => ({ type })),
  { maxLength: 40 },
);

type Step = {
  from: TerminalState;
  event: TerminalEvent;
  to: TerminalState;
  generationBefore: number;
  generationAfter: number;
};

/** Applies events from `creating`, skipping the ones the current state rejects. */
function walk(sequence: TerminalEvent[]): Step[] {
  const steps: Step[] = [];
  let state: TerminalState = "creating";
  let generation = 0;
  for (const event of sequence) {
    let to: TerminalState = state;
    try {
      to = nextState(state, event);
    } catch (error) {
      if (!(error instanceof InvalidTransition)) throw error;
    }
    const generationAfter = to === state ? generation : nextGeneration(state, event, generation);
    steps.push({ from: state, event, to, generationBefore: generation, generationAfter });
    state = to;
    generation = generationAfter;
  }
  return steps;
}

const finalStatesStayFinal = (steps: Step[]) =>
  steps.filter((s) => isFinal(s.from)).every((s) => s.to === s.from);

const lostOnlyOnTargetAbsent = (steps: Step[]) =>
  steps
    .filter((s) => s.to === "lost" && s.from !== "lost")
    .every((s) => s.event.type === "target.absent");

const generationRisesOnlyOnRespawn = (steps: Step[]) =>
  steps.every((s) =>
    s.generationAfter === s.generationBefore
      ? true
      : s.generationAfter === s.generationBefore + 1 &&
        s.from === "exited" &&
        s.event.type === "respawned",
  );

const unreachability = fc.array(
  fc
    .constantFrom<TerminalEvent["type"]>("runtime.unreachable", "runtime.reconfirmed")
    .map((type): TerminalEvent => ({ type })),
  { maxLength: 40 },
);
const startRunning: TerminalEvent[] = [{ type: "runtime.confirmed" }];
const neverLost = (steps: Step[]) => steps.every((s) => s.to !== "lost");

describe("terminal state machine, over any sequence of events", () => {
  it("never leaves closed or failed", () => {
    expect(() =>
      fc.assert(fc.property(events, (e) => finalStatesStayFinal(walk(e)))),
    ).not.toThrow();
  });

  it("becomes lost only on positive evidence that the target is gone", () => {
    expect(() =>
      fc.assert(fc.property(events, (e) => lostOnlyOnTargetAbsent(walk(e)))),
    ).not.toThrow();
  });

  it("raises the generation by one, and only when an exited terminal respawns", () => {
    expect(() =>
      fc.assert(fc.property(events, (e) => generationRisesOnlyOnRespawn(walk(e)))),
    ).not.toThrow();
  });

  it("never concludes lost while the runtime is merely unreachable", () => {
    expect(() =>
      fc.assert(fc.property(unreachability, (e) => neverLost(walk([...startRunning, ...e])))),
    ).not.toThrow();
  });
});

// Invariants of every state table, over random event sequences rather than hand-picked ones.
// The pattern to copy for a new table (docs/standards/testing.md): a pure walk at module scope,
// one predicate per invariant, and `fc.assert` inside the test.

import * as fc from "fast-check";
import type { MailboxState, TerminalState } from "@bazhen/protocol";
import { describe, expect, it } from "vitest";
import { agent, type AgentEvent } from "./agent.ts";
import { InvalidTransition, type Machine } from "./machine.ts";
import { mailbox, type MailboxEvent } from "./mailbox.ts";
import { advanceTerminal, terminal, type TerminalEvent } from "./terminal.ts";

interface Step<S, E> {
  readonly from: S;
  readonly event: E;
  readonly to: S;
  readonly accepted: boolean;
}

/** Where `event` leads from `from`, or undefined when the table refuses it. */
function tryNext<S extends string, E extends string>(m: Machine<S, E>, from: S, event: E) {
  try {
    return m.next(from, event);
  } catch (error) {
    if (!(error instanceof InvalidTransition)) throw error;
    return undefined;
  }
}

/** Applies events from `start`, recording the ones the current state refuses as no-ops. */
function walk<S extends string, E extends string>(m: Machine<S, E>, start: S, events: E[]) {
  const steps: Step<S, E>[] = [];
  let state = start;
  for (const event of events) {
    const to = tryNext(m, state, event);
    steps.push({ from: state, event, to: to ?? state, accepted: to !== undefined });
    state = to ?? state;
  }
  return steps;
}

/** Every state reachable from `start` through the table. */
function reachable<S extends string, E extends string>(m: Machine<S, E>, start: S, events: E[]) {
  const seen = new Set<S>([start]);
  for (const s of seen) for (const event of events) seen.add(tryNext(m, s, event) ?? s);
  return [...seen].toSorted();
}

/** Random sequences, weighted so most walks live long enough to reach the interesting states. */
const sequences = <E extends string>(weights: [E, number][]) =>
  fc.array(
    fc.oneof(...weights.map(([event, weight]) => ({ weight, arbitrary: fc.constant(event) }))),
    { maxLength: 40 },
  );

/** The events `state` accepts; a final state accepts none. */
const accepted = <S extends string, E extends string>(m: Machine<S, E>, state: S, events: E[]) =>
  events.filter((e) => tryNext(m, state, e) !== undefined);

const entersOnlyBy = <S, E>(steps: Step<S, E>[], state: S, events: E[]) =>
  steps.filter((s) => s.to === state && s.from !== state).every((s) => events.includes(s.event));

const check =
  <T>(arb: fc.Arbitrary<T>, predicate: (value: T) => boolean) =>
  () =>
    fc.assert(fc.property(arb, predicate));

// ---- terminal

const TERMINAL_EVENTS: [TerminalEvent, number][] = [
  ["runtime.confirmed", 4],
  ["runtime.rejected", 1],
  ["process.exited", 4],
  ["runtime.unreachable", 2],
  ["runtime.reconfirmed", 2],
  ["target.absent", 1],
  ["respawned", 4],
  ["relinked", 1],
  ["close.requested", 1],
  ["close.completed", 1],
];
const terminalWalks = sequences(TERMINAL_EVENTS).map((e) => walk(terminal, "creating", e));
const ALL_TERMINAL_STATES: TerminalState[] = [
  "creating",
  "running",
  "exited",
  "unknown",
  "lost",
  "closing",
  "closed",
  "failed",
];

/** How much each accepted step raised the generation. */
const rise = (s: Step<TerminalState, TerminalEvent>) =>
  s.accepted ? advanceTerminal({ state: s.from, generation: 0 }, s.event).generation : 0;

const generationRisesOnlyOnNewIncarnation = (steps: Step<TerminalState, TerminalEvent>[]) =>
  steps.every(
    (s) => rise(s) === 0 || (rise(s) === 1 && (s.event === "respawned" || s.event === "relinked")),
  );

const respawnRaisesGeneration = (steps: Step<TerminalState, TerminalEvent>[]) =>
  steps.filter((s) => s.from === "exited" && s.event === "respawned").every((s) => rise(s) === 1);

describe("terminal, over any sequence of events", () => {
  it("accepts no event once closed or failed", () => {
    const events = TERMINAL_EVENTS.map(([e]) => e);
    expect([accepted(terminal, "closed", events), accepted(terminal, "failed", events)]).toEqual([
      [],
      [],
    ]);
  });

  it("becomes lost only on positive evidence that the target is gone", () => {
    expect(
      check(terminalWalks, (steps) => entersOnlyBy(steps, "lost", ["target.absent"])),
    ).not.toThrow();
  });

  it("raises the generation only by one, and only on a respawn or re-link", () => {
    expect(check(terminalWalks, generationRisesOnlyOnNewIncarnation)).not.toThrow();
  });

  it("raises the generation on every respawn of an exited terminal", () => {
    expect(check(terminalWalks, respawnRaisesGeneration)).not.toThrow();
  });

  it("can reach every state, so the walks above exercise the whole table", () => {
    const events = TERMINAL_EVENTS.map(([e]) => e);
    expect(reachable(terminal, "creating", events)).toEqual(ALL_TERMINAL_STATES.toSorted());
  });
});

// ---- agent session

const AGENT_EVENTS: [AgentEvent, number][] = [
  ["launch.confirmed", 4],
  ["launch.rejected", 1],
  ["process.exited", 3],
  ["environment.unreachable", 2],
  ["environment.reconfirmed", 2],
  ["target.absent", 1],
  ["respawn.requested", 3],
  ["relaunch.requested", 2],
  ["close.requested", 1],
  ["close.completed", 1],
];
const agentWalks = sequences(AGENT_EVENTS).map((e) => walk(agent, "starting", e));

describe("agent session, over any sequence of events", () => {
  it("accepts no event once closed or failed", () => {
    const events = AGENT_EVENTS.map(([e]) => e);
    expect([accepted(agent, "closed", events), accepted(agent, "failed", events)]).toEqual([
      [],
      [],
    ]);
  });

  it("becomes lost only when a reachable environment lacks the target", () => {
    expect(
      check(agentWalks, (steps) => entersOnlyBy(steps, "lost", ["target.absent"])),
    ).not.toThrow();
  });

  it("starts again only on an explicit respawn or relaunch", () => {
    expect(
      check(agentWalks, (steps) =>
        entersOnlyBy(steps, "starting", ["respawn.requested", "relaunch.requested"]),
      ),
    ).not.toThrow();
  });

  it("can reach every state", () => {
    const events = AGENT_EVENTS.map(([e]) => e);
    expect(reachable(agent, "starting", events)).toEqual(
      [
        "starting",
        "running",
        "exited",
        "unknown",
        "lost",
        "closing",
        "closed",
        "failed",
      ].toSorted(),
    );
  });
});

// ---- mailbox message

const MAILBOX_EVENTS: [MailboxEvent, number][] = [
  ["offer", 3],
  ["ack", 3],
  ["seen", 2],
  ["confirm", 2],
  ["accept", 1],
  ["requeue", 2],
  ["give_up", 1],
  ["agent_closed", 1],
];
const mailboxWalks = sequences(MAILBOX_EVENTS).map((e) => walk(mailbox, "queued", e));

const neverOfferedAfterDelivery = (steps: Step<MailboxState, MailboxEvent>[]) =>
  steps.filter((s) => s.from === "delivered").every((s) => !s.accepted);

describe("mailbox message, over any sequence of events", () => {
  it("is never offered again once delivered", () => {
    expect(check(mailboxWalks, neverOfferedAfterDelivery)).not.toThrow();
  });

  it("is delivered only once a turn confirms it, never on Codex storing it", () => {
    expect(
      check(mailboxWalks, (steps) => entersOnlyBy(steps, "delivered", ["confirm"])),
    ).not.toThrow();
  });

  it("is undeliverable only after the re-offer cap or the agent closing", () => {
    expect(
      check(mailboxWalks, (steps) =>
        entersOnlyBy(steps, "undeliverable", ["give_up", "agent_closed"]),
      ),
    ).not.toThrow();
  });

  it("can reach every state", () => {
    const events = MAILBOX_EVENTS.map(([e]) => e);
    expect(reachable(mailbox, "queued", events)).toEqual(
      [
        "queued",
        "offered",
        "emitted",
        "seen",
        "queued_in_codex",
        "delivered",
        "undeliverable",
      ].toSorted(),
    );
  });
});

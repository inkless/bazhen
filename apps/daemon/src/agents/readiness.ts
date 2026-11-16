import type { TerminalId } from "@bazhen/core";
import type { EventPayload } from "@bazhen/protocol";
import type { Recorded } from "../store/projections.ts";
import type { AgentTerminal, Store } from "../store/store.ts";

/** Which of its harness's signs said an agent is up. */
export type Sign = EventPayload<"agent.ready">["sign"];

/** The events that confirm a start's terminal, after which the agent waits on its harness. */
const STARTS: ReadonlySet<string> = new Set([
  "agent.running",
  "agent.respawned",
  "agent.relaunched",
]);
/** The events after which an agent no longer waits on its harness. */
const SETTLES: ReadonlySet<string> = new Set([
  "agent.ready",
  "agent.exited",
  "agent.lost",
  "agent.closing",
]);

/** The events that start or end a reuse of an agent's terminal, and which option each tells. */
const REUSES: Partial<Record<string, "terminalReused" | "terminalLeft">> = {
  "agent.respawn_requested": "terminalReused",
  "agent.respawn_rejected": "terminalLeft",
  "agent.closing": "terminalLeft",
};

export interface ReadinessOptions {
  readonly store: Store;
  readonly environmentId: string;
  /** How long a harness has, once its terminal runs, before the human is told. */
  readonly deadlineMs: number;
  /** Opens the item for an agent whose harness hasn't come up. */
  readonly notStarted: (agentId: string, summary: string) => void;
  /** A start's terminal runs, and may already show a sign of life that came before it did. */
  readonly terminalUp?: (terminalId: TerminalId) => void;
  /** A start is asked for in the agent's own terminal, which keeps what the last process left. */
  readonly terminalReused?: (terminalId: TerminalId) => void;
  /** That start is refused, or the agent is closing: nothing will start in the terminal. */
  readonly terminalLeft?: (terminalId: TerminalId) => void;
  /** The agent runs now: mail held while it started may go. */
  readonly released?: (agentId: string) => void;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

const waiting = (a: AgentTerminal | undefined) =>
  a?.state === "starting" && a.terminalState === "running";

/**
 * Launch readiness (foundation-design §4.5): an agent whose terminal runs is still starting
 * until its harness shows a sign of life, since a TUI held at a trust, login or update dialog
 * isn't running. Once a start has waited `deadlineMs`, the human is told, once per start, to look
 * at its terminal. Nothing here writes to a terminal: only the human answers what a TUI asks.
 */
export class Readiness {
  private readonly opts: ReadinessOptions;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts: ReadinessOptions) {
    this.opts = opts;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.warn;
  }

  /**
   * Records the harness's first sign of life since the agent's terminal came up. A sign before
   * then, or after the agent runs, changes nothing.
   */
  ready(agentId: string, sign: Sign): void {
    const { store } = this.opts;
    const recorded = store.transaction(() => {
      if (!waiting(store.agentTerminal({ agentId }))) return false;
      store.append({ type: "agent.ready", entityId: agentId, actor: "system", payload: { sign } });
      return true;
    });
    if (recorded) this.opts.released?.(agentId);
  }

  /**
   * Times every start already waiting, as after a restart, from when its terminal came up, and
   * each one from now on. Returns the stop function.
   */
  follow(): () => void {
    const { store, environmentId } = this.opts;
    for (const a of store.recoverable(environmentId)) {
      const start = waiting(a) ? store.startOf(a.agentId) : undefined;
      if (start !== undefined) this.arm(a.agentId, start.eventId, start.at);
    }
    const stop = store.react((e) => this.react(e));
    return () => {
      stop();
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    };
  }

  private react(e: Recorded): void {
    const told = REUSES[e.type];
    if (told !== undefined) {
      const terminalId = this.opts.store.agentTerminal({ agentId: e.entityId })?.runtime
        ?.terminalId;
      if (terminalId !== undefined) this.opts[told]?.(terminalId);
    }
    if (SETTLES.has(e.type)) {
      clearTimeout(this.timers.get(e.entityId));
      this.timers.delete(e.entityId);
      return;
    }
    if (!STARTS.has(e.type)) return;
    const found = this.opts.store.agentTerminal({ agentId: e.entityId });
    if (!waiting(found)) return;
    this.arm(e.entityId, e.id, Date.parse(e.ts));
    const terminalId = found?.runtime?.terminalId;
    // After the start commits, so whatever reads the terminal finds the agent on it.
    if (terminalId !== undefined) queueMicrotask(() => this.opts.terminalUp?.(terminalId));
  }

  private arm(agentId: string, startId: number, at: number): void {
    clearTimeout(this.timers.get(agentId));
    const delay = Math.max(0, at + this.opts.deadlineMs - this.now());
    const timer = setTimeout(() => this.fire(agentId, startId), delay);
    timer.unref();
    this.timers.set(agentId, timer);
  }

  /**
   * Tells the human, unless the start has settled or they were told of it already. A later start
   * cleared this one's timer when it armed its own.
   */
  private fire(agentId: string, startId: number): void {
    this.timers.delete(agentId);
    const { store } = this.opts;
    try {
      store.transaction(() => {
        if (!waiting(store.agentTerminal({ agentId }))) return;
        if (store.openedSince(agentId, "stuck_starting", startId)) return;
        this.opts.notStarted(agentId, this.summary(store.agentLaunch(agentId)?.launch.harness));
      });
    } catch (err) {
      this.log(
        `readiness: could not tell the human agent ${agentId} hasn't started; ` +
          `trying again in ${this.opts.deadlineMs} ms: ${String(err)}`,
      );
      this.arm(agentId, startId, this.now());
    }
  }

  private summary(harness: string | undefined): string {
    const seconds = Math.round(this.opts.deadlineMs / 1000);
    const said = `Its harness hasn't shown it is up after ${seconds} s. Look in its terminal for a dialog to answer.`;
    // Codex has one sign Bazhen can see; a build that ignores the setting never gives it.
    return harness === "codex"
      ? `${said} If Codex is up with no dialog, Bazhen didn't see it title its terminal with its thread: check that this Codex honours tui.terminal_title.`
      : said;
  }
}

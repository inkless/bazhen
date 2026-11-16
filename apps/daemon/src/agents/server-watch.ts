import type { AgentInventoryEntry, EnvironmentAdapter } from "@bazhen/core";
import type { AgentTerminal, Store } from "../store/store.ts";
import { byRuntime } from "../terminals/runtimes.ts";
import type { AgentQueue } from "./queue.ts";
import { provablyGone, settle } from "./reconcile.ts";

const TICK_MS = 5_000;
/** The longest a health read that wasn't reachable waits for the next; each one doubles it. */
const MAX_BACKOFF_MS = 5 * 60_000;

export interface ServerWatchOptions {
  readonly store: Store;
  readonly environment: EnvironmentAdapter;
  /** The agents' command queue; an agent a command holds is in flight, and is left to it. */
  readonly queue: AgentQueue;
  /** Runs on every tick after the agents' check, whatever it found, as shells settle theirs. */
  readonly alsoEachTick?: () => Promise<void>;
  readonly intervalMs?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

/** How one runtime last read, and when it is next read. */
interface Reading {
  backoff: number;
  at: number;
  health: string;
}

/**
 * Reconciles the environment's agents while the daemon runs, as boot does, so a tmux server that
 * dies under it leaves its agents lost rather than running (foundation-design §7.1). Each runtime
 * is read with its own agents, by itself (design §5.4). The store is read before the runtime, so
 * an agent it lists had its terminal before the inventory was read, and each agent is settled in
 * its own command slot, after reading it again: a launch, respawn or close in flight is never
 * concluded on. A health reading other than reachable may have signalled the runtime to recreate
 * its socket, so that runtime's next read waits a doubling delay, and the others don't.
 */
export class ServerWatch {
  private readonly opts: ServerWatchOptions;
  private readonly intervalMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private timer: ReturnType<typeof setInterval> | undefined;
  private ticking: Promise<void> | undefined;
  private stopped = false;
  private readonly readings = new Map<string, Reading>();
  /** The last failure of a whole check, so a persistent one is said once. */
  private fault: string | undefined;
  /** The last thing said of each agent that couldn't be concluded on, so it is said once. */
  private readonly said = new Map<string, string>();

  constructor(opts: ServerWatchOptions) {
    this.opts = opts;
    this.intervalMs = opts.intervalMs ?? TICK_MS;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.warn;
  }

  start(): void {
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
  }

  /** Stops the timer; a check under way settles no agent it hasn't started on. */
  stop(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.timer = undefined;
  }

  /**
   * One check; a check asked for while one runs gets that one. A check that fails, the store
   * busy or closing say, is logged and the next one runs as usual: it never rejects, so a timer's
   * tick can't end the daemon.
   */
  tick(): Promise<void> {
    this.ticking ??= this.check()
      .then(() => this.opts.alsoEachTick?.())
      .then(() => (this.fault = undefined))
      .catch((err: unknown) => {
        const fault = `server watch: check failed: ${String(err)}`;
        if (fault !== this.fault) this.log(fault);
        this.fault = fault;
      })
      .finally(() => (this.ticking = undefined));
    return this.ticking;
  }

  private async check(): Promise<void> {
    const { store, environment, queue } = this.opts;
    const agents = store.recoverable(environment.id).filter((a) => !queue.busy(a.agentId));
    for (const [runtime, on] of byRuntime(environment, agents)) await this.checkOn(runtime, on);
  }

  private async checkOn(runtime: string, agents: readonly AgentTerminal[]): Promise<void> {
    const { environment, queue } = this.opts;
    if (this.now() < this.reading(runtime).at) return;
    let present: Map<string, AgentInventoryEntry>;
    try {
      const known = agents.flatMap((a) => (a.runtime === null ? [] : [a.runtime]));
      const { state } = await environment.health(known, runtime);
      this.read(runtime, state);
      if (state !== "reachable") return;
      present = new Map((await environment.inventory(runtime)).map((e) => [e.agentId, e]));
    } catch (err) {
      this.read(runtime, `unreadable (${String(err)})`);
      return;
    }
    for (const agent of agents) {
      const found = present.get(agent.agentId);
      if (found !== undefined && agent.state !== "starting") this.said.delete(agent.agentId);
      else if (!queue.busy(agent.agentId)) await this.settle(agent, found);
    }
  }

  private async settle(agent: AgentTerminal, found: AgentInventoryEntry | undefined) {
    const { store, environment, queue } = this.opts;
    const { agentId } = agent;
    const say = (message: string) => {
      if (this.said.get(agentId) !== message) this.log(message);
      this.said.set(agentId, message);
    };
    // The slot is held while gone() probes, so a command on this agent waits out one bounded
    // tmux and ps read; a command can't start on what is being proven gone.
    await queue
      .run(agentId, async () => {
        if (this.stopped || !unchanged(agent, store.agentTerminal({ agentId }))) return;
        if (found === undefined && !(await provablyGone(environment, agent, say))) return;
        // Settled as the agent is now: the exit poller records exits outside the queue, so one
        // may have landed during the probe. A different terminal or generation proves nothing.
        store.transaction(() => {
          const now = store.agentTerminal({ agentId });
          if (now === undefined || !sameTerminal(agent, now)) return;
          settle(store, now, found);
          this.said.delete(agentId);
        });
      })
      .catch((err: unknown) =>
        say(`server watch: could not settle agent ${agentId}: ${String(err)}`),
      );
  }

  private reading(runtime: string): Reading {
    let reading = this.readings.get(runtime);
    if (reading === undefined) {
      reading = { backoff: 0, at: 0, health: "reachable" };
      this.readings.set(runtime, reading);
    }
    return reading;
  }

  /** Backs off from a runtime's reading that wasn't reachable, and says only what changed. */
  private read(runtime: string, state: string): void {
    const reading = this.reading(runtime);
    if (state === "reachable") reading.backoff = 0;
    else reading.backoff = Math.min(Math.max(reading.backoff * 2, this.intervalMs), MAX_BACKOFF_MS);
    reading.at = this.now() + reading.backoff;
    if (state !== reading.health)
      this.log(`server watch: environment ${this.opts.environment.id}'s ${runtime} is ${state}`);
    reading.health = state;
  }
}

/** Nothing moved the agent between the check's read and its slot. */
function unchanged(before: AgentTerminal, now: AgentTerminal | undefined): boolean {
  return (
    now !== undefined &&
    now.state === before.state &&
    now.terminalState === before.terminalState &&
    sameTerminal(before, now)
  );
}

/** The same incarnation of the agent's terminal, whatever has been recorded of its process. */
const sameTerminal = (before: AgentTerminal, now: AgentTerminal) =>
  now.generation === before.generation &&
  JSON.stringify(now.runtime) === JSON.stringify(before.runtime);

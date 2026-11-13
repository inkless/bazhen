import {
  advanceTerminal,
  agentCommands,
  canResume,
  NoTerminal,
  NotResumable,
  ProcessState,
  StaleIncarnation,
  terminal,
  TerminalUnconfirmed,
  type EnvironmentAdapter,
  type RuntimeRef,
} from "@bazhen/core";
import {
  AgentCommandResponse,
  type AgentState,
  type CloseAgentRequest,
  type EventPayload,
  type EventType,
  type ExitStatus,
  type RespawnAgentRequest,
  type SignalAgentRequest,
} from "@bazhen/protocol";
import { runtimePayload, UnknownAgent, type AgentTerminal, type Store } from "../store/store.ts";

/** A command named a generation the agent's terminal has moved past (foundation-design §10). */
export class StaleGeneration extends Error {
  constructor(agentId: string, current: number | null) {
    super(`agent ${agentId} is at generation ${String(current)}`);
  }
}

/** The agent's state does not allow the command, and never will. */
export class AgentStateConflict extends Error {
  constructor(agentId: string, state: string) {
    super(`agent ${agentId} is ${state}`);
  }
}

/**
 * The terminal's tmux server or pane is not the one recorded, so it can't be acted on safely.
 * Repeating the command won't help; restart recovery settles what happened to it.
 */
export class TerminalReplaced extends Error {
  constructor(agentId: string, cause: unknown) {
    super(`agent ${agentId}'s terminal is not the one recorded; its server or pane has changed`, {
      cause,
    });
  }
}

/**
 * The agent's terminal is gone from view, but the server it ran on may still run it, so close
 * can't call it ended; only a forced close records it closed (foundation-design §7.1).
 */
export class ServerUnconfirmed extends Error {
  constructor(agentId: string, cause: unknown) {
    super(
      `agent ${agentId}'s terminal is not on the tmux server, but the server it ran on may still ` +
        "be running it; close it with force to record it closed anyway",
      { cause },
    );
  }
}

/** The environment could not act just now; the command can be repeated. */
export class EnvironmentUnavailable extends Error {
  constructor(agentId: string, cause: unknown) {
    super(`could not reach the environment running agent ${agentId}`, { cause });
  }
}

/** A message's states before it reaches its agent or can't. */
const IN_FLIGHT = ["queued", "offered", "emitted", "seen", "queued_in_codex"] as const;

/**
 * Records a closing agent closed, and the mail still on its way to it undeliverable, since it
 * can no longer reach it (foundation-design §4.7). Returns the events' ids.
 */
export function recordClosed(store: Store, agentId: string, actor: "user" | "system"): number[] {
  return [
    store.append({ type: "agent.closed", entityId: agentId, actor, payload: {} }),
    ...store.mail(agentId, IN_FLIGHT).map((m) =>
      store.append({
        type: "mailbox.undeliverable",
        entityId: m.id,
        actor: "system",
        payload: { reason: "agent_closed" },
      }),
    ),
  ];
}

/**
 * Every change to an agent after its launch (foundation-design §4.5): its process ending, and the
 * commands close, respawn and signal. Commands on one agent run one at a time; an exit landing
 * during one is recorded only if the agent is still running then.
 */
export class Lifecycle {
  private readonly store: Store;
  private readonly environment: EnvironmentAdapter;
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(store: Store, environment: EnvironmentAdapter) {
    this.store = store;
    this.environment = environment;
  }

  /** Records agents' exits as the environment reports them; returns the stop function. */
  watch(): () => void {
    return this.environment.onExit((ref, status) => this.exited(ref, status));
  }

  /**
   * The environment reports every dead terminal on every check, so a report about a terminal that
   * is no longer running, or about an earlier generation, changes nothing.
   */
  private exited(ref: RuntimeRef, status: ExitStatus): void {
    const found = this.store.agentTerminal({ terminalId: ref.terminalId });
    if (found?.terminalState == null || !terminal.accepts(found.terminalState, "process.exited"))
      return;
    if (ref.locator.generation !== String(found.generation)) return;
    this.store.append({
      type: "agent.exited",
      entityId: found.agentId,
      actor: "system",
      payload: { exit: status },
    });
  }

  /**
   * Ends an agent and its terminal. `closing` is recorded before the terminal is touched; if the
   * environment can't be reached the agent stays closing, and the same command finishes it later.
   * A lost agent's terminal is already gone, so it closes without the environment.
   */
  close(agentId: string, req: CloseAgentRequest): Promise<AgentCommandResponse> {
    // Force only finishes a close already refused: anything else still ends its terminal.
    const accepts = req.force === true ? (state: AgentState) => state === "closing" : closable;
    return this.command("close", agentId, req, accepts, async (found) => {
      if (found.state === "closed") return () => [];
      const closing =
        found.state === "closing"
          ? this.store.lastEventId(agentId, "agent.closing")
          : this.record(agentId, "agent.closing", {});
      if (found.state !== "lost") {
        await this.environment
          .close({ runtime: found.runtime, externalRef: null })
          .catch((cause: unknown) => {
            // Force records closed only what a close could not end: a terminal its old server may
            // still run, or one an environment that can't be reached holds. It never skips a close
            // that would work, so a terminal on a reachable server is still ended.
            if (req.force !== true || !forceable(cause)) fromEnvironment(agentId, cause);
            console.warn(
              `agent ${agentId} closed by force; its terminal's tmux server ` +
                `(pid ${found.runtime?.locator.serverPid ?? "unknown"}) may still be running it`,
            );
          });
      }
      return () => [
        ...(closing === undefined ? [] : [closing]),
        ...recordClosed(this.store, agentId, "user"),
      ];
    });
  }

  /**
   * Starts an exited agent again on its harness session, at the next generation. `starting` is
   * recorded first, so a daemon that dies meanwhile finds a respawn to settle; a rejected respawn,
   * an unreachable environment included, returns the agent to exited, its terminal kept and
   * still closable.
   */
  respawn(agentId: string, req: RespawnAgentRequest): Promise<AgentCommandResponse> {
    return this.command("respawn", agentId, req, respawnable, async (found) => {
      const launched = this.store.agentLaunch(agentId);
      if (launched === undefined || found.terminalState === null || found.generation === null)
        throw new NoTerminal();
      // Known before anything happens, so it is refused with nothing recorded.
      const { externalRef, launch } = launched;
      if (
        externalRef === null ||
        !canResume({ harness: launch.harness, externalRef }, this.environment.resumable)
      )
        throw new NotResumable(found.agentId);
      const next = advanceTerminal(
        { state: found.terminalState, generation: found.generation },
        "respawned",
      );
      const requested = this.record(agentId, "agent.respawn_requested", {});
      const refs = await this.environment
        .respawn({
          agentId: found.agentId,
          request: launch,
          refs: { runtime: found.runtime, externalRef },
          generation: next.generation,
        })
        .catch((cause: unknown) => {
          this.record(agentId, "agent.respawn_rejected", { reason: rejection(cause) });
          return fromEnvironment(agentId, cause);
        });
      const runtimeRef = runtimePayload(refs.runtime);
      // The new TUI can move its binding while it starts, as a quick /clear does; that rebind is
      // newer than the session it resumed, so it stands.
      const current = this.store.agentLaunch(agentId)?.externalRef ?? null;
      const rebound = current !== null && current.id !== externalRef.id;
      return () => [
        requested,
        this.record(agentId, "agent.respawned", {
          externalRef: rebound ? current : refs.externalRef,
          runtimeRef,
        }),
      ];
    });
  }

  /** Signals a running agent's process; an exit it causes is recorded when the runtime sees it. */
  signal(agentId: string, req: SignalAgentRequest): Promise<AgentCommandResponse> {
    return this.command("signal", agentId, req, running, async (found) => {
      await this.environment
        .signal({ runtime: found.runtime, externalRef: null }, req.signal)
        .catch((cause: unknown) => fromEnvironment(agentId, cause));
      return () => [this.record(agentId, "agent.signalled", { signal: req.signal })];
    });
  }

  /**
   * One command on one agent: a repeated key gets the first answer; otherwise the agent must be in
   * a state the command accepts, at the generation it names. `act` does the work and returns the
   * last step, which is recorded with the key's answer, so a repeat always gets this answer.
   */
  private command(
    name: string,
    agentId: string,
    req: { readonly idempotencyKey: string; readonly generation: number },
    accepts: (state: AgentState) => boolean,
    act: (found: AgentTerminal) => Promise<() => number[]>,
  ): Promise<AgentCommandResponse> {
    const request = { command: name, agentId, ...req };
    return this.serially(agentId, async () => {
      const prior = this.store.replay(req.idempotencyKey, request, (r) =>
        AgentCommandResponse.parse(r),
      );
      if (prior !== undefined) return prior;
      const found = this.store.agentTerminal({ agentId });
      if (found === undefined) throw new UnknownAgent(agentId);
      if (!accepts(found.state)) throw new AgentStateConflict(agentId, found.state);
      if (found.generation !== req.generation) throw new StaleGeneration(agentId, found.generation);
      const last = await act(found);
      return this.store.transaction(() => {
        const response = { agentId, eventIds: last() };
        this.store.answered(req.idempotencyKey, request, response);
        return response;
      });
    });
  }

  private record<T extends AgentEventType>(
    agentId: string,
    type: T,
    payload: EventPayload<T>,
  ): number {
    return this.store.append({ type, entityId: agentId, actor: "user", payload });
  }

  private serially<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(agentId) ?? Promise.resolve()).then(run);
    // The queue only orders commands; each caller gets its own command's failure from `next`.
    const settled = next.catch(() => {});
    this.queues.set(agentId, settled);
    void settled.then(() => {
      if (this.queues.get(agentId) === settled) this.queues.delete(agentId);
    });
    return next;
  }
}

type AgentEventType = Extract<EventType, `agent.${string}`>;

const closable = (state: AgentState) =>
  state === "closed" || agentCommands(state).includes("close");
const respawnable = (state: AgentState) => agentCommands(state).includes("respawn");
const running = (state: AgentState) => agentCommands(state).includes("signal");

/** A close failure force may record past: unconfirmed, or the environment out of reach. */
const forceable = (cause: unknown) =>
  cause instanceof TerminalUnconfirmed ||
  ![StaleIncarnation, NoTerminal, NotResumable, ProcessState].some((e) => cause instanceof e);

/** An environment's failure as the command's: typed where the caller can act on it. */
function fromEnvironment(agentId: string, cause: unknown): never {
  if (cause instanceof StaleIncarnation) throw new TerminalReplaced(agentId, cause);
  if (cause instanceof TerminalUnconfirmed) throw new ServerUnconfirmed(agentId, cause);
  if (cause instanceof NoTerminal || cause instanceof NotResumable || cause instanceof ProcessState)
    throw cause;
  throw new EnvironmentUnavailable(agentId, cause);
}

function rejection(cause: unknown): EventPayload<"agent.respawn_rejected">["reason"] {
  if (cause instanceof NotResumable) return "not_resumable";
  if (cause instanceof NoTerminal) return "no_terminal";
  if (cause instanceof StaleIncarnation || cause instanceof ProcessState) return "terminal_changed";
  return "unavailable";
}

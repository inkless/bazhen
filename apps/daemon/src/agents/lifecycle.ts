import {
  advanceTerminal,
  AgentTerminalExists,
  agentCommands,
  newId,
  NoTerminal,
  NotResumable,
  ProcessState,
  StaleIncarnation,
  terminal,
  type EnvironmentAdapter,
  type RuntimeRef,
  type Size,
} from "@bazhen/core";
import {
  AgentCommandResponse,
  type AgentState,
  type CloseAgentRequest,
  type EventPayload,
  type EventType,
  type ExitStatus,
  type RelaunchAgentRequest,
  type RespawnAgentRequest,
  type SignalAgentRequest,
} from "@bazhen/protocol";
import {
  forceable,
  fromEnvironment as failed,
  StaleGeneration,
  StateConflict,
} from "../commands.ts";
import { launchOptions } from "./launch.ts";
import type { AgentQueue } from "./queue.ts";
import { runtimePayload, UnknownAgent, type AgentTerminal, type Store } from "../store/store.ts";

export {
  EnvironmentUnavailable,
  ServerUnconfirmed,
  StaleGeneration,
  StateConflict as AgentStateConflict,
  TerminalReplaced,
} from "../commands.ts";

/** What starting an agent again, by respawn or relaunch, needs beyond store and environment. */
export interface StartAgainDeps {
  /** The new terminal's size until a view attaches and sets its own. */
  readonly size: Size;
  /**
   * The agent's last process is gone for good: what its hooks held (mail handed over, approvals
   * asked, what it was doing) is settled before the new one starts.
   */
  readonly replaced: (agentId: string) => void;
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
  private readonly queue: AgentQueue;
  private readonly startAgain: StartAgainDeps;

  constructor(
    store: Store,
    environment: EnvironmentAdapter,
    queue: AgentQueue,
    startAgain: StartAgainDeps,
  ) {
    this.store = store;
    this.environment = environment;
    this.queue = queue;
    this.startAgain = startAgain;
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
      const { externalRef, launch, transcript } = launched;
      if (
        externalRef === null ||
        !this.environment.resumes({ harness: launch.harness, externalRef, transcript })
      )
        throw new NotResumable(found.agentId);
      const next = advanceTerminal(
        { state: found.terminalState, generation: found.generation },
        "respawned",
      );
      const requested = this.record(agentId, "agent.respawn_requested", {});
      this.startAgain.replaced(agentId);
      const refs = await this.environment
        .respawn({
          agentId: found.agentId,
          request: launch,
          options: launchOptions(req.theme),
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
          ...(refs.theme && { theme: refs.theme }),
        }),
      ];
    });
  }

  /**
   * Starts a lost agent again on a new terminal, at the next generation (foundation-design §4.1).
   * It resumes the agent's harness session, or starts a new one only when `fresh` asks; one that
   * can't resume is refused with nothing recorded. A rejected relaunch leaves the agent lost on
   * its old terminal, still closable.
   */
  relaunch(agentId: string, req: RelaunchAgentRequest): Promise<AgentCommandResponse> {
    return this.command("relaunch", agentId, req, relaunchable, async (found) => {
      const launched = this.store.agentLaunch(agentId);
      if (launched === undefined || found.generation === null) throw new NoTerminal();
      const { externalRef, launch, transcript } = launched;
      const fresh = req.fresh === true;
      if (!fresh && !this.environment.resumes({ harness: launch.harness, externalRef, transcript }))
        throw new NotResumable(found.agentId);
      const terminalId = newId("term");
      const generation = found.generation + 1;
      const requested = this.record(agentId, "agent.relaunch_requested", {
        terminalId,
        generation,
        fresh,
      });
      this.startAgain.replaced(agentId);
      const refs = await this.environment
        .launch({
          agentId: found.agentId,
          terminalId,
          generation,
          resume: fresh ? null : externalRef,
          request: launch,
          options: launchOptions(req.theme),
          size: this.startAgain.size,
        })
        .then(({ runtime, ...rest }) => {
          if (runtime === null) throw new NoTerminal();
          return { ...rest, runtime };
        })
        .catch((cause: unknown) => {
          this.record(agentId, "agent.relaunch_rejected", { reason: relaunchRejection(cause) });
          if (cause instanceof AgentTerminalExists) throw cause;
          return fromEnvironment(agentId, cause);
        });
      const runtimeRef = runtimePayload(refs.runtime);
      // As after a respawn, a binding the new TUI moved to while it started is the newer one.
      const current = this.store.agentLaunch(agentId)?.externalRef ?? null;
      const rebound = current !== null && current.id !== externalRef?.id;
      return () => [
        requested,
        this.record(agentId, "agent.relaunched", {
          externalRef: rebound ? current : refs.externalRef,
          runtimeRef,
          ...(refs.theme && { theme: refs.theme }),
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
    return this.queue.run(agentId, async () => {
      const prior = this.store.replay(req.idempotencyKey, request, (r) =>
        AgentCommandResponse.parse(r),
      );
      if (prior !== undefined) return prior;
      const found = this.store.agentTerminal({ agentId });
      if (found === undefined) throw new UnknownAgent(agentId);
      if (!accepts(found.state)) throw new StateConflict(`agent ${agentId}`, found.state);
      if (found.generation !== req.generation)
        throw new StaleGeneration(`agent ${agentId}`, found.generation);
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
}

type AgentEventType = Extract<EventType, `agent.${string}`>;

const closable = (state: AgentState) =>
  state === "closed" || agentCommands(state).includes("close");
const respawnable = (state: AgentState) => agentCommands(state).includes("respawn");
const relaunchable = (state: AgentState) => agentCommands(state).includes("relaunch");
const running = (state: AgentState) => agentCommands(state).includes("signal");

function rejection(cause: unknown): EventPayload<"agent.respawn_rejected">["reason"] {
  if (cause instanceof NotResumable) return "not_resumable";
  if (cause instanceof NoTerminal) return "no_terminal";
  if (cause instanceof StaleIncarnation || cause instanceof ProcessState) return "terminal_changed";
  return "unavailable";
}

/** An environment's failure as a command on the agent's. */
const fromEnvironment = (agentId: string, cause: unknown): never =>
  failed(`agent ${agentId}`, cause);

function relaunchRejection(cause: unknown): EventPayload<"agent.relaunch_rejected">["reason"] {
  if (cause instanceof NotResumable) return "not_resumable";
  if (cause instanceof AgentTerminalExists) return "terminal_exists";
  return "unavailable";
}

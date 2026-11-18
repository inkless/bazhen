import {
  advanceTerminal,
  agent,
  AgentTerminalExists,
  agentCommands,
  HarnessRefused,
  laterGeneration,
  newId,
  NoTerminal,
  NotResumable,
  ProcessState,
  StaleIncarnation,
  terminal,
  type AgentSessionId,
  type EnvironmentAdapter,
  type RuntimeRef,
  type Size,
} from "@bazhen/core";
import {
  AgentCommandResponse,
  type CloseAgentRequest,
  type EventPayload,
  type EventType,
  type ExitStatus,
  type ExternalRef,
  type RelaunchAgentRequest,
  type RespawnAgentRequest,
  type SignalAgentRequest,
  type TuiTheme,
} from "@bazhen/protocol";
import {
  failureDetail,
  forceable,
  stillRunning,
  fromEnvironment as failed,
  StaleGeneration,
  StateConflict,
} from "../commands.ts";
import { startWithToken, type AgentTokenIssuer } from "../auth/callers.ts";
import type { TerminalAdmission } from "../terminals/budget.ts";
import { preparePrompt, startOptions, startedAs } from "./launch.ts";
import type { Prompts } from "./prompts.ts";
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
  /** A relaunch opens a new terminal, so it asks for a slot; a respawn keeps its terminal's. */
  readonly budget: TerminalAdmission;
  /** Each start gets a new token, which ends the last one's; a close removes the file. */
  readonly tokens: AgentTokenIssuer;
  readonly prompts: Prompts;
}

/**
 * The Codex thread an agent would resume is held by another agent too, as a store from before
 * one agent held a thread may have it: a start would put both on it.
 */
export class ThreadTaken extends NotResumable {
  constructor(agentId: AgentSessionId, threadId: string, others: readonly string[]) {
    super(agentId);
    this.message = `agent ${agentId} can't resume Codex thread ${threadId}: ${others.join(", ")} is on it too`;
  }
}

/** Refuses a start of `agentId` on `externalRef` if that is a Codex thread another agent holds. */
function refuseTaken(store: Store, agentId: AgentSessionId, externalRef: ExternalRef | null) {
  if (externalRef?.kind !== "codex-thread") return;
  const others = store.codexThreadHolders(externalRef.id).filter((id) => id !== agentId);
  if (others.length > 0) throw new ThreadTaken(agentId, externalRef.id, others);
}

/**
 * Whether `found` runs `ref` as a process started outside the daemon, which it takes as its own: a
 * later generation of the same holder or server than its record names, so the recorded process
 * has ended. A start in flight owns its terminal, and the daemon's own respawn is in flight while
 * its terminal is exited, so a starting agent is adopted only once its terminal runs. A closing one
 * never is: its close ends the terminal whatever runs in it.
 */
export function adopts(found: AgentTerminal, ref: RuntimeRef): boolean {
  if (!agent.accepts(found.state, "process.adopted")) return false;
  if (found.state === "starting" && found.terminalState !== "running") return false;
  return found.runtime !== null && laterGeneration(found.runtime, ref) && pastCount(found, ref);
}

/**
 * Whether `ref`'s generation is past the one the store counts for the terminal, which an adoption
 * must be: a record whose locator names another must not let one through that the store refuses.
 */
export function pastCount(found: { readonly generation: number | null }, ref: RuntimeRef): boolean {
  return found.generation !== null && Number(ref.locator.generation) > found.generation;
}

/** Records `ref`, a process started outside the daemon, as the agent's own. */
export function recordAdopted(store: Store, agentId: string, ref: RuntimeRef): number {
  return store.append({
    type: "agent.process_adopted",
    entityId: agentId,
    actor: "system",
    payload: { runtimeRef: runtimePayload(ref) },
  });
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
    return this.environment.onProcess((ref, exit) => {
      if (exit !== null) this.exited(ref, exit);
    });
  }

  /**
   * The environment reports every dead terminal on every check, so a report about a terminal that
   * is no longer running, or about an earlier generation, changes nothing. One about a later
   * generation is of a process started outside the daemon, which is adopted as it exits.
   */
  private exited(ref: RuntimeRef, status: ExitStatus): void {
    const found = this.store.agentTerminal({ terminalId: ref.terminalId });
    if (found === undefined) return;
    const exit = {
      type: "agent.exited",
      entityId: found.agentId,
      actor: "system",
      payload: { exit: status },
    } as const;
    if (adopts(found, ref)) {
      this.store.transaction(() => {
        recordAdopted(this.store, found.agentId, ref);
        this.store.append(exit);
      });
      return;
    }
    if (found.terminalState == null || !terminal.accepts(found.terminalState, "process.exited"))
      return;
    if (ref.locator.generation !== String(found.generation)) return;
    this.store.append(exit);
  }

  /**
   * Ends an agent and its terminal. `closing` is recorded before the terminal is touched; if the
   * environment can't be reached the agent stays closing, and the same command finishes it later.
   * A lost agent's terminal is already gone, so it closes without the environment.
   */
  close(agentId: string, req: CloseAgentRequest): Promise<AgentCommandResponse> {
    // Force only finishes a close already refused: anything else still ends its terminal.
    const accepts = req.force === true ? (a: Commandable) => a.state === "closing" : closable;
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
            console.warn(`agent ${agentId} closed by force; ${stillRunning(found.runtime)}`);
          });
      }
      this.startAgain.tokens.forget(agentId);
      return () => [...(closing === undefined ? [] : [closing]), ...this.closed(agentId)];
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
      refuseTaken(this.store, found.agentId, externalRef);
      const next = advanceTerminal(
        { state: found.terminalState, generation: found.generation },
        "respawned",
      );
      const started = this.startOptions(agentId, launched, req.theme);
      const requested = this.record(agentId, "agent.respawn_requested", {});
      this.startAgain.replaced(agentId);
      const refs = await startWithToken(this.startAgain.tokens, found.agentId, (tokenFile) =>
        this.environment.respawn({
          agentId: found.agentId,
          request: launch,
          options: started.options,
          refs: { runtime: found.runtime, externalRef },
          generation: next.generation,
          tokenFile,
        }),
      ).catch((cause: unknown) => {
        this.record(agentId, "agent.respawn_rejected", rejection(cause));
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
          ...startedAs(started.options),
          promptHash: started.promptHash,
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
      if (!fresh) refuseTaken(this.store, found.agentId, externalRef);
      const terminalId = newId("term");
      const generation = found.generation + 1;
      this.startAgain.budget.admit();
      // A new terminal, so on the runtime of the moment, wherever the lost one was.
      const on = this.environment.defaultRuntime;
      const started = this.startOptions(agentId, launched, req.theme);
      const requested = this.record(agentId, "agent.relaunch_requested", {
        terminalId,
        generation,
        fresh,
        runtime: on,
      });
      this.startAgain.replaced(agentId);
      const refs = await startWithToken(this.startAgain.tokens, found.agentId, (tokenFile) =>
        this.environment
          .launch({
            agentId: found.agentId,
            terminalId,
            generation,
            resume: fresh ? null : externalRef,
            request: launch,
            options: started.options,
            size: this.startAgain.size,
            runtime: on,
            tokenFile,
          })
          .then(({ runtime, ...rest }) => {
            if (runtime === null) throw new NoTerminal();
            return { ...rest, runtime };
          }),
      ).catch((cause: unknown) => {
        this.record(agentId, "agent.relaunch_rejected", relaunchRejection(cause));
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
          ...startedAs(started.options),
          promptHash: started.promptHash,
        }),
      ];
    });
  }

  /** One more start of the agent, with its prompt as its role's file says it now. */
  private startOptions(
    agentId: string,
    launched: {
      readonly name: string;
      readonly role: string | null;
      readonly promptHash: string | null;
      readonly compactWindowTokens: number | null;
    },
    theme: TuiTheme | undefined,
  ) {
    const prompt = preparePrompt(
      this.startAgain.prompts,
      agentId,
      launched.role,
      launched.promptHash,
    );
    return {
      options: startOptions(prompt, launched.name, theme, launched.compactWindowTokens),
      promptHash: prompt.hash,
    };
  }

  /** Records the agent closed, and removes the prompt file its starts read. */
  private closed(agentId: string): number[] {
    const ids = recordClosed(this.store, agentId, "user");
    this.startAgain.prompts.remove(agentId);
    return ids;
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
    accepts: (a: Commandable) => boolean,
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
      if (!accepts(found)) throw new StateConflict(`agent ${agentId}`, found.state);
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

type Commandable = Pick<AgentTerminal, "state" | "terminalState">;
const closable = (a: Commandable) => a.state === "closed" || agentCommands(a).includes("close");
const respawnable = (a: Commandable) => agentCommands(a).includes("respawn");
const relaunchable = (a: Commandable) => agentCommands(a).includes("relaunch");
const running = (a: Commandable) => agentCommands(a).includes("signal");

function rejection(cause: unknown): EventPayload<"agent.respawn_rejected"> {
  const detail = failureDetail(cause);
  if (cause instanceof NotResumable) return { reason: "not_resumable", detail };
  if (cause instanceof NoTerminal) return { reason: "no_terminal", detail };
  if (cause instanceof StaleIncarnation || cause instanceof ProcessState)
    return { reason: "terminal_changed", detail };
  if (cause instanceof HarnessRefused) return { reason: "harness_refused", detail };
  return { reason: "unavailable", detail };
}

/** An environment's failure as a command on the agent's. */
const fromEnvironment = (agentId: string, cause: unknown): never =>
  failed(`agent ${agentId}`, cause);

function relaunchRejection(cause: unknown): EventPayload<"agent.relaunch_rejected"> {
  const detail = failureDetail(cause);
  if (cause instanceof NotResumable) return { reason: "not_resumable", detail };
  if (cause instanceof AgentTerminalExists) return { reason: "terminal_exists", detail };
  if (cause instanceof HarnessRefused) return { reason: "harness_refused", detail };
  return { reason: "unavailable", detail };
}

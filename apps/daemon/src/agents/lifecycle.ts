import { agent, terminal, type EnvironmentAdapter, type RuntimeRef } from "@bazhen/core";
import { AgentCommandResponse, type CloseAgentRequest, type ExitStatus } from "@bazhen/protocol";
import { UnknownAgent, type Store } from "../store/store.ts";

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

/** The environment could not act just now; the command can be repeated. */
export class EnvironmentUnavailable extends Error {
  constructor(agentId: string, cause: unknown) {
    super(`could not reach the environment running agent ${agentId}`, { cause });
  }
}

/**
 * Every change to an agent after its launch (foundation-design §4.5): its process ending, and
 * close. Closes of one agent run one at a time; an exit landing during one finds the agent no
 * longer running, and changes nothing.
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
    const request = { agentId, ...req };
    return this.serially(agentId, async () => {
      const prior = this.store.replay(req.idempotencyKey, request, (r) =>
        AgentCommandResponse.parse(r),
      );
      if (prior !== undefined) return prior;
      const found = this.store.agentTerminal({ agentId });
      if (found === undefined) throw new UnknownAgent(agentId);
      if (found.state === "closed") return { agentId, eventIds: [] };
      if (found.state !== "closing" && !agent.accepts(found.state, "close.requested"))
        throw new AgentStateConflict(agentId, found.state);
      if (found.generation !== req.generation) throw new StaleGeneration(agentId, found.generation);

      const append = (type: "agent.closing" | "agent.closed") =>
        this.store.append({ type, entityId: agentId, actor: "user", payload: {} });
      const eventIds = found.state === "closing" ? [] : [append("agent.closing")];
      if (found.state !== "lost") {
        await this.environment
          .close({ runtime: found.runtime, externalRef: null })
          .catch((cause: unknown) => {
            throw new EnvironmentUnavailable(agentId, cause);
          });
      }
      // The last event and the key's answer go together, so a repeat always gets this answer.
      return this.store.transaction(() => {
        const response = { agentId, eventIds: [...eventIds, append("agent.closed")] };
        this.store.answered(req.idempotencyKey, request, response);
        return response;
      });
    });
  }

  private serially<T>(agentId: string, run: () => Promise<T>): Promise<T> {
    const next = (this.queues.get(agentId) ?? Promise.resolve()).then(run);
    // The queue only orders closes; each caller gets its own close's failure from `next`.
    const settled = next.catch(() => {});
    this.queues.set(agentId, settled);
    void settled.then(() => {
      if (this.queues.get(agentId) === settled) this.queues.delete(agentId);
    });
    return next;
  }
}

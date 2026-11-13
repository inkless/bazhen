import type { AgentInventoryEntry, EnvironmentAdapter } from "@bazhen/core";
import { runtimePayload, type AgentTerminal, type Store } from "../store/store.ts";
import { recordClosed } from "./lifecycle.ts";

/**
 * After a restart, matches the environment's agents against the store's (foundation-design §7.1).
 * Its recorded refs let the environment tell a runtime that died, which is reachable and empty,
 * from one it can't read just now. An environment that can't be read, or fails while being read,
 * concludes nothing, because an unreadable source is not an empty one; boot goes on either way.
 * Runs before any command is taken, so nothing moves under it. A pane that died meanwhile is the
 * exit poller's to record, on its first check.
 */
export async function reconcile(
  store: Store,
  environment: EnvironmentAdapter,
  log: (message: string) => void = console.warn,
): Promise<void> {
  const agents = store.recoverable(environment.id);
  let present: Map<string, AgentInventoryEntry>;
  try {
    const known = agents.flatMap((a) => (a.runtime === null ? [] : [a.runtime]));
    if ((await environment.health(known)).state !== "reachable") return;
    present = new Map((await environment.inventory()).map((e) => [e.agentId, e]));
  } catch (err) {
    log(`reconcile: could not read environment ${environment.id}: ${String(err)}`);
    return;
  }
  for (const agent of agents)
    store.transaction(() => settle(store, agent, present.get(agent.agentId)));
}

/** One agent's events, from what the store says of it and what the environment still has. */
function settle(store: Store, agent: AgentTerminal, found: AgentInventoryEntry | undefined): void {
  const { agentId, state, terminalState, generation } = agent;
  const system = { entityId: agentId, actor: "system" } as const;
  if (state === "starting" && terminalState === "creating") {
    // The daemon died mid-launch: the tagged session is the launch, or there is none.
    store.append(
      found === undefined
        ? { ...system, type: "agent.failed", payload: { reason: "daemon_restart" } }
        : {
            ...system,
            type: "agent.running",
            payload: { externalRef: null, runtimeRef: runtimePayload(found.ref) },
          },
    );
    return;
  }
  if (state === "starting" && terminalState === "exited" && generation !== null) {
    // The daemon died mid-respawn. The generation is written before the new process starts, so
    // the next one means it started.
    if (found !== undefined && found.ref.locator.generation === String(generation + 1)) {
      const externalRef = store.agentLaunch(agentId)?.externalRef ?? null;
      const runtimeRef = runtimePayload(found.ref);
      store.append({ ...system, type: "agent.respawned", payload: { externalRef, runtimeRef } });
      return;
    }
    store.append({
      ...system,
      type: "agent.respawn_rejected",
      payload: { reason: "daemon_restart" },
    });
    if (found === undefined) store.append({ ...system, type: "agent.lost", payload: {} });
    return;
  }
  if (found !== undefined) return;
  if (state === "running" || state === "exited")
    store.append({ ...system, type: "agent.lost", payload: {} });
  else if (state === "closing") recordClosed(store, agentId, "system");
}

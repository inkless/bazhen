import type { AgentInventoryEntry, EnvironmentAdapter } from "@bazhen/core";
import { runtimePayload, type AgentTerminal, type Store } from "../store/store.ts";
import { byRuntime, unrouted } from "../terminals/runtimes.ts";
import { adopts, recordAdopted, recordClosed } from "./lifecycle.ts";

/**
 * After a restart, matches the environment's agents against the store's (foundation-design §7.1),
 * one runtime at a time, each with the agents made on it. Their recorded refs let the runtime tell
 * one that died, which is reachable and empty, from one it can't read just now. A runtime that
 * can't be read, or fails while being read, concludes nothing about its agents, because an
 * unreadable source is not an empty one; the other runtimes and boot go on either way. Runs before
 * any command is taken, so nothing moves under it. A pane that died meanwhile is the exit poller's
 * to record, on its first check.
 */
export async function reconcile(
  store: Store,
  environment: EnvironmentAdapter,
  log: (message: string) => void = console.warn,
): Promise<void> {
  const agents = store.recoverable(environment.id);
  for (const { agentId, runtimeKind } of unrouted(environment, agents))
    log(
      `reconcile: agent ${agentId}'s terminal is on ${runtimeKind}, which this daemon doesn't run`,
    );
  for (const [runtime, on] of byRuntime(environment, agents))
    await reconcileOn(store, environment, runtime, on, log);
}

async function reconcileOn(
  store: Store,
  environment: EnvironmentAdapter,
  runtime: string,
  agents: readonly AgentTerminal[],
  log: (message: string) => void,
): Promise<void> {
  let present: Map<string, AgentInventoryEntry>;
  try {
    const known = agents.flatMap((a) => (a.runtime === null ? [] : [a.runtime]));
    if ((await environment.health(known, runtime)).state !== "reachable") return;
    present = new Map((await environment.inventory(runtime)).map((e) => [e.agentId, e]));
  } catch (err) {
    log(`reconcile: could not read environment ${environment.id}'s ${runtime}: ${String(err)}`);
    return;
  }
  for (const agent of agents) {
    const found = present.get(agent.agentId);
    if (found === undefined && !(await provablyGone(environment, agent, log))) continue;
    store.transaction(() => settle(store, agent, found));
  }
}

/**
 * Whether what ran an agent the inventory lacks is provably gone, by the rule close goes by: a
 * server that may still run it, its socket taken by a new one, is no proof. An agent with no
 * terminal yet has nothing to prove gone.
 */
export async function provablyGone(
  environment: EnvironmentAdapter,
  { agentId, runtime }: AgentTerminal,
  log: (message: string) => void,
): Promise<boolean> {
  if (runtime === null) return true;
  const gone = await environment.gone({ runtime, externalRef: null }).catch((err: unknown) => {
    log(`reconcile: could not tell whether agent ${agentId}'s terminal is gone: ${String(err)}`);
    return false;
  });
  if (!gone) log(`reconcile: agent ${agentId}'s terminal may still run on its old server; left`);
  return gone;
}

/** One agent's events, from what the store says of it and what the environment still has. */
export function settle(
  store: Store,
  agent: AgentTerminal,
  found: AgentInventoryEntry | undefined,
): void {
  const { agentId, state, terminalState, generation } = agent;
  const system = { entityId: agentId, actor: "system" } as const;
  if (
    state === "starting" &&
    terminalState === "creating" &&
    store.lastEventId(agentId, "agent.relaunch_requested") !== undefined
  ) {
    // The daemon died mid-relaunch: the tagged session is the new terminal, or the agent is lost
    // again, never failed, as a relaunch that can't start leaves it.
    store.append(
      found === undefined
        ? { ...system, type: "agent.relaunch_rejected", payload: { reason: "daemon_restart" } }
        : {
            ...system,
            type: "agent.relaunched",
            payload: {
              externalRef: found.externalRef ?? store.agentLaunch(agentId)?.externalRef ?? null,
              runtimeRef: runtimePayload(found.ref),
            },
          },
    );
    return;
  }
  if (state === "starting" && terminalState === "creating") {
    // The daemon died mid-launch: the tagged session is the launch, with the harness session it
    // carries, or there is none.
    store.append(
      found === undefined
        ? { ...system, type: "agent.failed", payload: { reason: "daemon_restart" } }
        : {
            ...system,
            type: "agent.running",
            payload: {
              externalRef: found.externalRef ?? null,
              runtimeRef: runtimePayload(found.ref),
            },
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
    else if (adopts({ ...agent, state: "exited" }, found.ref))
      recordAdopted(store, agentId, found.ref);
    return;
  }
  if (found !== undefined) {
    // Dead, it is the exit poller's to record, on its first check, at the generation adopted.
    if (adopts(agent, found.ref)) recordAdopted(store, agentId, found.ref);
    return;
  }
  // A starting agent whose terminal runs is waiting on its harness, and is lost as a running one.
  const ran = state === "running" || (state === "starting" && terminalState === "running");
  if (ran || state === "exited") store.append({ ...system, type: "agent.lost", payload: {} });
  else if (state === "closing") recordClosed(store, agentId, "system");
}

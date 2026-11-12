import type { EnvironmentAdapter } from "@bazhen/core";
import type { Store } from "../store/store.ts";

/**
 * After a restart, matches the environment's agents against the store's (foundation-design §7).
 * An agent the environment still runs stays as it is; one it positively lacks is lost. An
 * environment that can't be read concludes nothing, because an unreadable source is not an
 * empty one.
 */
export async function reconcile(store: Store, environment: EnvironmentAdapter): Promise<void> {
  if ((await environment.health()).state !== "reachable") return;
  const present = new Set<string>((await environment.inventory()).map((e) => e.agentId));
  for (const agent of store.snapshot().agents) {
    if (agent.environmentId !== environment.id || agent.state !== "running") continue;
    if (present.has(agent.id)) continue;
    store.append({ type: "agent.lost", entityId: agent.id, actor: "system", payload: {} });
  }
}

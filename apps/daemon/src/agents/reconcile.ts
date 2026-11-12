import type { EnvironmentAdapter } from "@bazhen/core";
import type { Store } from "../store/store.ts";

/**
 * After a restart, matches the environment's agents against the store's (foundation-design §7).
 * An agent the environment still runs stays as it is; one a reachable environment lacks is lost.
 * An environment that can't be read, or fails while being read, concludes nothing, because an
 * unreadable source is not an empty one; boot goes on either way.
 */
export async function reconcile(
  store: Store,
  environment: EnvironmentAdapter,
  log: (message: string) => void = console.warn,
): Promise<void> {
  let present: Set<string>;
  try {
    if ((await environment.health()).state !== "reachable") return;
    present = new Set((await environment.inventory()).map((e) => e.agentId));
  } catch (err) {
    log(`reconcile: could not read environment ${environment.id}: ${String(err)}`);
    return;
  }
  for (const id of store.runningAgents(environment.id)) {
    if (!present.has(id))
      store.append({ type: "agent.lost", entityId: id, actor: "system", payload: {} });
  }
}

import type { EnvironmentAdapter } from "@bazhen/core";
import type { Store } from "../store/store.ts";
import { recordClosed } from "./lifecycle.ts";

/**
 * After a restart, matches the environment's agents against the store's (foundation-design §7).
 * An agent the environment still has stays as it is. One a reachable environment lacks is lost,
 * or, if it was being closed, closed. Its recorded refs let the environment tell a runtime that
 * died, which is reachable and empty, from one it can't read just now. An environment that can't
 * be read, or fails while being read, concludes nothing, because an unreadable source is not an
 * empty one; boot goes on either way. Runs before any command is taken, so nothing moves under it.
 */
export async function reconcile(
  store: Store,
  environment: EnvironmentAdapter,
  log: (message: string) => void = console.warn,
): Promise<void> {
  const agents = store.recoverable(environment.id);
  let present: Set<string>;
  try {
    const known = agents.flatMap((a) => (a.runtime === null ? [] : [a.runtime]));
    if ((await environment.health(known)).state !== "reachable") return;
    present = new Set((await environment.inventory()).map((e) => e.agentId));
  } catch (err) {
    log(`reconcile: could not read environment ${environment.id}: ${String(err)}`);
    return;
  }
  for (const { agentId, state } of agents) {
    if (present.has(agentId)) continue;
    if (state === "running" || state === "exited") {
      store.append({ type: "agent.lost", entityId: agentId, actor: "system", payload: {} });
    } else if (state === "closing") {
      store.transaction(() => recordClosed(store, agentId, "system"));
    }
  }
}

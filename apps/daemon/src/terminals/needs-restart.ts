import type { EnvironmentAdapter } from "@bazhen/core";
import type { Store } from "../store/store.ts";

/**
 * Records, once each, the terminals not yet ended that run where this build can't fully serve
 * them, such as on a holder of an older protocol major (design §4.7). What runs a terminal keeps
 * its version for life, so one record lasts it. A runtime that can't be read throws.
 */
export async function recordOutdated(store: Store, environment: EnvironmentAdapter): Promise<void> {
  const outdated = (await environment.outdated?.()) ?? new Map<string, readonly string[]>();
  for (const [terminalId, protocol] of outdated) {
    if (!store.restartUnrecorded(terminalId)) continue;
    store.append({
      type: "terminal.needs_restart",
      entityId: terminalId,
      actor: "system",
      payload: { protocol: [...protocol] },
    });
  }
}

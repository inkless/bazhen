import { setImmediate } from "node:timers/promises";
import type { Store } from "../store/store.ts";

/** Events are kept 30 days; projections are kept for good (foundation-design §12, decision 3). */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Retires every event older than the retention period, a batch at a time, yielding between
 * batches so hooks waiting on the daemon are never held behind a long first prune.
 */
export async function retire(store: Pick<Store, "pruneBatch">, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  while (store.pruneBatch(cutoff)) await setImmediate();
}

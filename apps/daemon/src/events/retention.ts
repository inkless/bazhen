import { setImmediate } from "node:timers/promises";
import type { Store } from "../store/store.ts";

/** Events are kept 30 days; projections are kept for good (foundation-design §12, decision 3). */
export const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Retires every event older than the retention period, a batch at a time, yielding between
 * batches so hooks waiting on the daemon are never held behind a long first prune. Stops between
 * batches once `signal` aborts, so a shutdown can close the store under it.
 */
export async function retire(
  store: Pick<Store, "pruneBatch">,
  now: Date,
  signal?: AbortSignal,
): Promise<void> {
  const cutoff = new Date(now.getTime() - RETENTION_MS);
  for (;;) {
    if (signal?.aborted === true || !store.pruneBatch(cutoff)) return;
    await setImmediate();
  }
}

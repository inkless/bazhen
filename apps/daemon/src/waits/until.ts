import type { Store } from "../store/store.ts";

/** Runs `fn` after `ms`, and answers with what calls it off; tests give one they run by hand. */
export type After = (ms: number, fn: () => void) => () => void;

export const realAfter: After = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/** Where a condition stands: `final` once nothing that commits later can change the answer. */
export interface Judged<T> {
  readonly final: boolean;
  readonly value: T;
}

/**
 * Answers with the first final judgement: the one made now, else one made after a commit. At
 * the timeout, or when `signal` aborts, it answers with a judgement made then. The first
 * judgement and the commit listener are set in one turn, so no commit falls between them. A
 * `judge` that throws rejects the wait. One wait that has answered holds nothing: no commit
 * listener, no timer, no abort listener.
 */
export function until<T>(
  store: Pick<Store, "onCommit">,
  judge: () => Judged<T>,
  timeoutMs: number,
  signal: AbortSignal,
  after: After = realAfter,
): Promise<T> {
  const first = judge();
  if (first.final || timeoutMs === 0 || signal.aborted) return Promise.resolve(first.value);
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      stopListening();
      cancelTimer();
      signal.removeEventListener("abort", now);
      settle();
    };
    const attempt = (only: (judged: Judged<T>) => boolean) => {
      try {
        const judged = judge();
        if (only(judged)) finish(() => resolve(judged.value));
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    };
    // Run from a timer, an abort or a commit, where a throw would end the daemon, not this wait.
    const now = () => attempt(() => true);
    const stopListening = store.onCommit(() => attempt((judged) => judged.final));
    const cancelTimer = after(timeoutMs, now);
    signal.addEventListener("abort", now);
  });
}

import {
  SETTLED,
  type Message,
  type WaitMessagesRequest,
  type WaitMessagesResponse,
} from "@bazhen/protocol";
import type { Store } from "../store/store.ts";

export class UnknownMessage extends Error {
  constructor(messageId: string) {
    super(`no message ${messageId}`);
  }
}

const settled = (messages: readonly Message[]) => messages.every((m) => SETTLED.has(m.state));

/** Runs `fn` after `ms`, and answers with what calls it off; tests give one they run by hand. */
export type After = (ms: number, fn: () => void) => () => void;

const realAfter: After = (ms, fn) => {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
};

/**
 * Answers once every message is settled, read again after each commit, or at the timeout or when
 * `signal` aborts, with the states then. A message this daemon never queued is refused at once,
 * and one wait that has answered holds nothing: no commit listener, no timer, no abort listener.
 */
export function waitForMail(
  store: Pick<Store, "messages" | "onCommit">,
  req: WaitMessagesRequest,
  signal: AbortSignal,
  after: After = realAfter,
): Promise<WaitMessagesResponse> {
  const read = (): Message[] => {
    const found = new Map(store.messages(req.messageIds).map((m) => [m.id, m]));
    return req.messageIds.map((id) => {
      const message = found.get(id);
      if (message === undefined) throw new UnknownMessage(id);
      return message;
    });
  };
  const first = read();
  if (settled(first) || req.timeoutMs === 0 || signal.aborted) {
    return Promise.resolve({ messages: first });
  }
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
    // Run from a timer or an abort, where a throw would end the daemon rather than this wait.
    const now = () => {
      try {
        const messages = read();
        finish(() => resolve({ messages }));
      } catch (err) {
        finish(() => reject(err instanceof Error ? err : new Error(String(err))));
      }
    };
    const stopListening = store.onCommit(() => {
      const messages = read();
      if (settled(messages)) finish(() => resolve({ messages }));
    });
    const cancelTimer = after(req.timeoutMs, now);
    signal.addEventListener("abort", now);
  });
}

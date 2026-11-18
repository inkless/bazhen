import {
  SETTLED,
  type Message,
  type WaitMessagesRequest,
  type WaitMessagesResponse,
} from "@bazhen/protocol";
import type { Store } from "../store/store.ts";
import { realAfter, until, type After } from "../waits/until.ts";

export class UnknownMessage extends Error {
  constructor(messageId: string) {
    super(`no message ${messageId}`);
  }
}

const settled = (messages: readonly Message[]) => messages.every((m) => SETTLED.has(m.state));

/**
 * Answers once every message is settled, read again after each commit, or at the timeout or when
 * `signal` aborts, with the states then. A message this daemon never queued is refused at once.
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
  return until(
    store,
    () => {
      const messages = read();
      return { final: settled(messages), value: { messages } };
    },
    req.timeoutMs,
    signal,
    after,
  );
}

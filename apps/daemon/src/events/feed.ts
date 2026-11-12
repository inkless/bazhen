import { EventFrame } from "@bazhen/protocol";
import type { Store } from "../store/store.ts";

/** Where a subscriber's frames go; `written` is called once a frame has left for the client. */
export interface FeedSink {
  send(frame: EventFrame, written?: () => void): void;
  close(): void;
  /** The feed broke on the daemon's side, and has stopped; the subscriber should be dropped. */
  fail(err: unknown): void;
}

/**
 * Streams the log to one subscriber from its cursor: the backlog, then each new event, every
 * one exactly once. One page is in flight at a time, so a slow client falls behind in the store
 * rather than in memory. The cursor is checked before every page, because retention can overtake
 * a client still reading an old backlog; one it can't resume gets `reset` and is closed. A page
 * that can't be sent fails this subscriber alone, before its cursor moves past it. Answers a
 * function that stops it.
 */
export function follow(
  store: Pick<Store, "cursorFault" | "events" | "onCommit">,
  cursor: { readonly epoch: string; readonly after: number },
  sink: FeedSink,
  page?: number,
): () => void {
  let after = cursor.after;
  let inFlight = false;
  let stopped = false;
  const next = (): void => {
    const fault = store.cursorFault(cursor.epoch, after);
    if (fault !== null) {
      stop();
      sink.send({ type: "reset", reason: fault });
      sink.close();
      return;
    }
    const events = store.events(after, page);
    const last = events.at(-1);
    if (last === undefined) return;
    const frames = events.map((event) => EventFrame.parse({ type: "event", event }));
    inFlight = true;
    after = last.id;
    frames.forEach((frame, i) => sink.send(frame, i === frames.length - 1 ? written : undefined));
  };
  const pump = (): void => {
    if (stopped || inFlight) return;
    try {
      next();
    } catch (err) {
      stop();
      sink.fail(err);
    }
  };
  // Whatever committed while the page was in flight is read by the pump that follows it.
  const written = () => {
    inFlight = false;
    pump();
  };
  const unsubscribe = store.onCommit(pump);
  const stop = () => {
    stopped = true;
    unsubscribe();
  };
  pump();
  return stop;
}

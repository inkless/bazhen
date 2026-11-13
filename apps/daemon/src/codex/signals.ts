import {
  readItemStarted,
  readThreadStatus,
  readTurn,
  resultActivity,
  type CodexActivity,
} from "@bazhen/harness-codex";
import type { Activity } from "@bazhen/protocol";
import type { ChannelListener } from "./channel.ts";

export interface CodexSignalsOptions {
  /** The running agent bound to a thread, if any. */
  readonly agentOf: (threadId: string) => string | undefined;
  readonly record: (agentId: string, signal: Activity) => void;
  /** Resumes a thread that unloaded, which loads it again and subscribes to it. */
  readonly resume: (threadId: string) => Promise<void>;
  readonly now?: () => Date;
  readonly log?: (message: string) => void;
}

export const AUTO_CONTINUED = "auto-continued after a Codex restart";
export const INTERRUPTED = "interrupted by a Codex restart";

/** Busy: a turn is running, whether or not it waits on the human. */
const busy = (a: CodexActivity | undefined) =>
  a === "working" || a === "needs_approval" || a === "waiting_input";

/**
 * Codex agents' activity, from their threads' status on the app-server (foundation-design §4.6,
 * §5.8). Each status becomes a native signal. `notLoaded` reads unknown and makes the thread be
 * resumed, once per connection, so it doesn't stick.
 *
 * A connection ends only when its server exits, and a turn running then ends with it. A new
 * server continues such a turn by itself after a restart or update, with no client attached, and
 * not after a stop and start. A thread that was busy at the end, and is busy again when it is
 * resumed, was auto-continued; one that is idle was interrupted, until a turn starts on it. That
 * turn is the new server's own if its first item is not the user's input: Codex announces a turn
 * before its items, so the label waits for the first one.
 */
export function codexSignals(opts: CodexSignalsOptions): Partial<ChannelListener> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? console.warn;
  /** Each thread's latest activity on the current connection. */
  let activity = new Map<string, CodexActivity>();
  /** Threads busy when the last connection ended, until they are resumed. */
  const cutOff = new Set<string>();
  /** Threads whose last turn failed on this connection, so the idle after it doesn't hide it. */
  let failed = new Set<string>();
  /** Interrupted threads whose new turn hasn't shown its first item yet. */
  const firstItem = new Set<string>();
  /** Threads resumed for having unloaded on this connection: each is resumed once. */
  let reloaded = new Set<string>();
  const labels = new Map<string, string>();

  /** A thread no running agent is bound to any more is forgotten. */
  const forget = (threadId: string) => {
    for (const s of [cutOff, failed, firstItem, reloaded]) s.delete(threadId);
    labels.delete(threadId);
    activity.delete(threadId);
  };

  const signal = (threadId: string, value: CodexActivity) => {
    const agentId = opts.agentOf(threadId);
    if (agentId === undefined) return forget(threadId);
    activity.set(threadId, value);
    const detail = labels.get(threadId);
    try {
      // An agent that has closed or exited records nothing; it doesn't throw.
      opts.record(agentId, {
        value,
        source: "native",
        confidence: 1,
        observedAt: now().toISOString(),
        ...(detail === undefined ? {} : { detail }),
      });
    } catch (err) {
      // The store failed, or doesn't know the agent; the thread's next status is tried again.
      log(`codex: could not record activity for ${agentId}: ${String(err)}`);
    }
  };

  const unloaded = (threadId: string) => {
    signal(threadId, "unknown");
    if (opts.agentOf(threadId) === undefined || reloaded.has(threadId)) return;
    reloaded.add(threadId);
    opts.resume(threadId).catch((err: unknown) => {
      log(`codex thread ${threadId} could not be resumed: ${String(err)}`);
    });
  };

  const status = (threadId: string, value: CodexActivity) => {
    if (value === "idle" && failed.has(threadId)) return;
    signal(threadId, value);
  };

  return {
    notification(method, params) {
      const changed = readThreadStatus(method, params);
      if (changed !== null) {
        return changed.notLoaded
          ? unloaded(changed.threadId)
          : status(changed.threadId, changed.activity);
      }
      const turn = readTurn(method, params);
      if (turn !== null) {
        const { threadId, ended } = turn;
        if (ended === null) {
          failed.delete(threadId);
          if (labels.get(threadId) === INTERRUPTED) {
            labels.delete(threadId);
            firstItem.add(threadId);
          }
          return signal(threadId, "working");
        }
        firstItem.delete(threadId);
        if (labels.get(threadId) === AUTO_CONTINUED) labels.delete(threadId);
        if (ended === "failed") {
          failed.add(threadId);
          return signal(threadId, "failed");
        }
        return signal(threadId, "idle");
      }
      const item = readItemStarted(method, params);
      if (item === null || !firstItem.delete(item.threadId) || item.userInput) return;
      // Nothing but the new server starts a turn on an interrupted thread with no input.
      labels.set(item.threadId, AUTO_CONTINUED);
      signal(item.threadId, activity.get(item.threadId) ?? "working");
    },
    disconnected() {
      for (const [threadId, a] of activity) if (busy(a)) cutOff.add(threadId);
      activity = new Map();
      failed = new Set();
      reloaded = new Set();
      firstItem.clear();
    },
    threadResumed(threadId, result) {
      const value = resultActivity(result);
      if (cutOff.delete(threadId)) {
        labels.set(threadId, busy(value ?? undefined) ? AUTO_CONTINUED : INTERRUPTED);
      }
      // Just resumed, so one that still reads notLoaded isn't resumed again.
      if (value !== null) status(threadId, value);
    },
  };
}

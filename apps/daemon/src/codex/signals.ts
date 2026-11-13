import {
  readThreadStatus,
  readTurn,
  readUserMessage,
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
 * §5.8). Each status becomes a native signal; `notLoaded` reads unknown and makes the thread
 * be resumed, so it doesn't stick.
 *
 * A connection ends only when its server exits, and a turn running then ends with it. A new
 * server continues such a turn by itself after a restart or update, with no client attached, and
 * not after a stop and start: a thread that was busy at the end, and is busy again when it is
 * resumed, was auto-continued; one that is idle was interrupted, until a turn starts on it. A
 * turn the human starts carries their input, which takes the label off.
 */
export function codexSignals(opts: CodexSignalsOptions): Partial<ChannelListener> {
  const now = opts.now ?? (() => new Date());
  const log = opts.log ?? console.warn;
  /** Each thread's latest activity on the current connection. */
  let activity = new Map<string, CodexActivity>();
  /** Threads busy when the last connection ended, until they are resumed. */
  const cutOff = new Set<string>();
  /** Threads whose last turn failed, so the idle status after it doesn't hide the failure. */
  const failed = new Set<string>();
  const labels = new Map<string, string>();

  const signal = (threadId: string, value: CodexActivity) => {
    activity.set(threadId, value);
    const agentId = opts.agentOf(threadId);
    if (agentId === undefined) return;
    const detail = labels.get(threadId);
    try {
      opts.record(agentId, {
        value,
        source: "native",
        confidence: 1,
        observedAt: now().toISOString(),
        ...(detail === undefined ? {} : { detail }),
      });
    } catch (err) {
      // An agent that closed a moment ago; the next status of a bound thread is recorded.
      log(`codex: could not record a signal for ${agentId}: ${String(err)}`);
    }
  };

  const status = (threadId: string, value: CodexActivity) => {
    if (value === "idle" && failed.has(threadId)) return;
    signal(threadId, value);
    if (value === "unknown" && opts.agentOf(threadId) !== undefined) {
      opts.resume(threadId).catch((err: unknown) => {
        log(`codex thread ${threadId} could not be resumed: ${String(err)}`);
      });
    }
  };

  return {
    notification(method, params) {
      const changed = readThreadStatus(method, params);
      if (changed !== null) return status(changed.threadId, changed.activity);
      const turn = readTurn(method, params);
      if (turn !== null) {
        const { threadId, ended } = turn;
        if (ended === null) {
          failed.delete(threadId);
          // Nothing but the new server starts a turn with no input on an interrupted thread.
          if (labels.get(threadId) === INTERRUPTED) labels.set(threadId, AUTO_CONTINUED);
          return signal(threadId, "working");
        }
        if (labels.get(threadId) === AUTO_CONTINUED) labels.delete(threadId);
        if (ended === "failed") {
          failed.add(threadId);
          return signal(threadId, "failed");
        }
        return signal(threadId, "idle");
      }
      const input = readUserMessage(method, params);
      if (input !== null && labels.delete(input.threadId)) {
        signal(input.threadId, activity.get(input.threadId) ?? "working");
      }
    },
    disconnected() {
      for (const [threadId, a] of activity) if (busy(a)) cutOff.add(threadId);
      activity = new Map();
    },
    threadResumed(threadId, result) {
      const value = resultActivity(result);
      if (cutOff.delete(threadId)) {
        labels.set(threadId, busy(value ?? undefined) ? AUTO_CONTINUED : INTERRUPTED);
      }
      // Just resumed: one that still reads notLoaded is not resumed again, which would loop.
      if (value === "unknown") signal(threadId, value);
      else if (value !== null) status(threadId, value);
    },
  };
}

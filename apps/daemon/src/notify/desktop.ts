import type { NotifierCommand, RunOutcome } from "@bazhen/host-guard";
import { EVENTS, type AttentionKind } from "@bazhen/protocol";
import type { Store } from "../store/store.ts";
import type { Presence } from "./presence.ts";

/** Runs a notifier by argv with a time limit; host-guard's `runNotifier` in the daemon. */
export type Run = (command: NotifierCommand, args: readonly string[]) => Promise<RunOutcome>;

/** Shows one notification on the host's desktop. */
export type Notify = (title: string, body: string) => void;

/**
 * The command that shows a notification on this platform, or null where Bazhen has none yet.
 * macOS gets its own notifier app later; osascript is never used, since its argv parsing lets a
 * title that starts with "-" add a script of its own.
 */
export function notificationCommand(
  platform: NodeJS.Platform,
  title: string,
  body: string,
): { command: NotifierCommand; args: string[] } | null {
  if (platform !== "linux") return null;
  // "--" ends notify-send's options, so a title or body that starts with "-" stays text.
  return { command: "notify-send", args: ["--app-name=Bazhen", "--", title, body] };
}

/**
 * Desktop notifications through the platform's own command, or null on a platform with none.
 * One runs at a time: what opens while one is showing is gathered into a single "N items need
 * you" once it returns, so a burst starts two processes, not fifty. A command that isn't
 * installed turns them off; that, and any other failure, is logged once and never thrown.
 */
export function desktopNotifier(
  platform: NodeJS.Platform,
  run: Run,
  log: (message: string) => void = console.warn,
): Notify | null {
  if (notificationCommand(platform, "", "") === null) return null;
  let off = false;
  let warned = false;
  let showing = false;
  let waiting = 0;
  const warn = (message: string) => {
    if (warned) return;
    warned = true;
    log(message);
  };
  const show = (title: string, body: string) => {
    const shown = notificationCommand(platform, title, body);
    if (off || shown === null) return;
    showing = true;
    void run(shown.command, shown.args).then((outcome) => {
      showing = false;
      if (outcome === "missing") {
        off = true;
        warn(`bazhen: desktop notifications are off: ${shown.command} is not installed`);
      } else if (outcome !== "ok") {
        warn(`bazhen: desktop notifications failed (${shown.command}: ${outcome})`);
      }
      const gathered = waiting;
      waiting = 0;
      if (gathered > 0)
        show("Bazhen", gathered === 1 ? "1 item needs you" : `${gathered} items need you`);
    });
  };
  return (title, body) => {
    if (off) return;
    if (showing) waiting++;
    else show(title, body);
  };
}

/**
 * What a notification says of each kind. A notification shows on a locked screen, so it never
 * carries the item's summary, which can hold a command, a URL or a token.
 */
const SAYS: Record<AttentionKind, string> = {
  approval: "A tool call needs your approval",
  question: "The agent asks you a question",
  failed: "A turn failed",
  undeliverable: "A message could not be delivered",
  escalation: "The agent needs you",
  task_done: "A task is done",
};

/**
 * Notifies the host's desktop of each attention item as it opens, unless a dashboard is in sight
 * to show it. Returns the stop function.
 */
export function notifyOnAttention(
  store: Store,
  presence: Presence,
  notify: Notify,
  now: () => number = Date.now,
): () => void {
  // Only what opens from now on: what was open before the daemon started isn't news.
  let cursor = store.latestEventId();
  return store.onCommit(() => {
    for (let batch = store.events(cursor); batch.length > 0; batch = store.events(cursor)) {
      for (const e of batch) {
        cursor = e.id;
        if (e.type !== "attention.opened" || presence.seen(now())) continue;
        // The store checked this payload as it recorded it; one that doesn't read now is
        // skipped rather than allowed to stop the notifications after it.
        const opened = EVENTS["attention.opened"].payload.safeParse(e.payload);
        if (!opened.success) continue;
        const { agentId, kind } = opened.data;
        notify(store.agent(agentId)?.project ?? "Bazhen", SAYS[kind ?? "approval"]);
      }
    }
  });
}

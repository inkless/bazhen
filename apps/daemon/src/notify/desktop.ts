import { fileURLToPath } from "node:url";
import { linuxNotifier, macNotifier, type ShowNotification } from "@bazhen/host-guard";
import { EVENTS, type AttentionKind } from "@bazhen/protocol";
import type { Store } from "../store/store.ts";
import type { Presence } from "./presence.ts";

/** Shows one notification on the host's desktop. */
export type Notify = (title: string, body: string) => void;

/** Bazhen.app where `pnpm build:notify` builds it by default. */
export const MAC_APP = fileURLToPath(
  new URL("../../../notify-mac/dist/Bazhen.app", import.meta.url),
);

/**
 * The notifier for this host, from host-guard, or null where Bazhen has none: notify-send on
 * Linux, Bazhen.app on macOS once it is built. osascript is never used: its argv parsing lets a
 * title that starts with "-" add a script of its own.
 */
export function hostNotifier(
  platform: NodeJS.Platform,
  found: { readonly notifySend: string | null; readonly macApp: string | null },
  port: number,
): ShowNotification | null {
  if (platform === "linux" && found.notifySend !== null) return linuxNotifier(found.notifySend);
  if (platform === "darwin" && found.macApp !== null) return macNotifier(found.macApp, port);
  return null;
}

/**
 * Desktop notifications through `show`. One runs at a time: what opens while one is showing is
 * gathered into a single "N items need you" once it returns, so a burst starts two notifiers,
 * not fifty. A notifier that can't start turns them off; that, and any other failure, is logged
 * once and never thrown.
 */
export function desktopNotifier(
  show: ShowNotification,
  log: (message: string) => void = console.warn,
): Notify {
  let off = false;
  let warned = false;
  let showing = false;
  let waiting = 0;
  const warn = (message: string) => {
    if (warned) return;
    warned = true;
    log(message);
  };
  const next = (title: string, body: string) => {
    if (off) return;
    showing = true;
    void show({ title, body }).then((outcome) => {
      showing = false;
      if (outcome === "missing") {
        off = true;
        warn("bazhen: desktop notifications are off: the notifier would not start");
      } else if (outcome !== "ok") {
        warn(`bazhen: desktop notifications failed (${outcome})`);
      }
      const gathered = waiting;
      waiting = 0;
      if (gathered > 0)
        next("Bazhen", gathered === 1 ? "1 item needs you" : `${gathered} items need you`);
    });
  };
  return (title, body) => {
    if (off) return;
    if (showing) waiting++;
    else next(title, body);
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

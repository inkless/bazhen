import type { Attention, StateSnapshot } from "@bazhen/protocol/web";
import { KINDS } from "./model.ts";
import { agentLabelOf } from "../fleet/model.ts";
import { deviceStorage } from "../storage.ts";

/**
 * The items opened since the last snapshot, and the ids now open. The first snapshot a page
 * reads (`seen` null) only seeds them: what was open before the page loaded isn't news.
 */
export function freshItems(
  seen: ReadonlySet<string> | null,
  state: StateSnapshot,
): { fresh: Attention[]; open: Set<string> } {
  const items = state.attention.filter((i) => i.state === "open");
  const open = new Set(items.map((i) => i.id));
  return { fresh: seen === null ? [] : items.filter((i) => !seen.has(i.id)), open };
}

/**
 * Whether this page can notify: `insecure` over plain http off this machine (browsers allow
 * notifications only in a secure context), `unsupported` with no Notification API, otherwise
 * the browser's permission.
 */
export type NotifyAccess = "insecure" | "unsupported" | NotificationPermission;

/** What the notifier needs from the browser; every call may throw, and none of them escapes. */
export interface NotifyDeps {
  readonly access: () => NotifyAccess;
  readonly request: () => Promise<NotificationPermission>;
  readonly stored: () => string | null;
  readonly store: (value: string) => void;
  readonly hidden: () => boolean;
  readonly show: (title: string, body: string, tag: string, onClick: () => void) => void;
}

const KEY = "bazhen.notifications";

const browser: NotifyDeps = {
  access: () => {
    if (!isSecureContext) return "insecure";
    return typeof Notification === "undefined" ? "unsupported" : Notification.permission;
  },
  request: () => Notification.requestPermission(),
  stored: () => deviceStorage.read(KEY),
  store: (value) => deviceStorage.write(KEY, value),
  hidden: () => document.visibilityState === "hidden",
  show: (title, body, tag, onClick) => {
    // Android Chrome has no Notification constructor (it throws "Illegal constructor"); that
    // throw is caught by the caller, and the page goes on without notifying.
    const n = new Notification(title, { body, tag });
    n.addEventListener("click", () => {
      onClick();
      n.close();
    });
  },
};

/** What a call answers when the browser throws: site data blocked, an API missing, anything. */
function guarded<T>(fallback: T, call: () => T): T {
  try {
    return call();
  } catch {
    // The page works without notifications; a browser that refuses one is not an error.
    return fallback;
  }
}

/** Whether notifications are on for this device: asked for here, and still allowed. */
export const notificationsOn = (deps: NotifyDeps = browser): boolean =>
  guarded(false, () => deps.access() === "granted" && deps.stored() === "on");

export const notifyAccess = (deps: NotifyDeps = browser): NotifyAccess =>
  guarded<NotifyAccess>("unsupported", deps.access);

/** Asks the browser, and answers what it now allows; on only once granted. */
export async function enableNotifications(deps: NotifyDeps = browser): Promise<NotifyAccess> {
  try {
    const permission = await deps.request();
    if (permission === "granted") deps.store("on");
    return permission;
  } catch {
    // A browser that can't ask can't notify either; the page says so.
    return "unsupported";
  }
}

export function disableNotifications(deps: NotifyDeps = browser): void {
  guarded(undefined, () => deps.store("off"));
}

/**
 * Notifies of each item opened since the last call while the page is hidden; a page in sight
 * already shows it. A lock screen shows a notification to anyone, so it names the kind and the
 * agent, never the summary, which can carry a command or a token. Clicking one brings the
 * page back on the inbox. It never throws: a browser that won't notify leaves the page as it is.
 */
export function pageNotifier(deps: NotifyDeps = browser) {
  let seen: Set<string> | null = null;
  return (state: StateSnapshot) => {
    const { fresh, open } = freshItems(seen, state);
    seen = open;
    if (fresh.length === 0 || !notificationsOn(deps) || !guarded(false, deps.hidden)) return;
    for (const item of fresh) {
      const agent = agentLabelOf(state.agents, item.agentId);
      guarded(undefined, () =>
        deps.show(agent, `${KINDS[item.kind].label}: needs you`, item.id, () => {
          focus();
          location.hash = "#/inbox";
        }),
      );
    }
  };
}

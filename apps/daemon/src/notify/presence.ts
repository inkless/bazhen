import { VISIBILITY_HEARTBEAT_MS } from "@bazhen/protocol";

/** How long a page that said it was in sight counts as in sight with no word since. */
export const SEEN_FOR_MS = 2 * VISIBILITY_HEARTBEAT_MS;

/**
 * Which dashboards are in sight, as each says on its event stream. A page in sight shows what
 * needs the human, so the host's desktop doesn't need to; one that went quiet, as a phone whose
 * screen went off does, stops counting once its last word is `SEEN_FOR_MS` old.
 */
export class Presence {
  /** When each open stream last said its page was in sight; null since it said it wasn't. */
  private readonly views = new Map<object, number | null>();

  report(view: object, visible: boolean, now: number): void {
    this.views.set(view, visible ? now : null);
  }

  gone(view: object): void {
    this.views.delete(view);
  }

  /** Whether some page is in sight now. */
  seen(now: number): boolean {
    for (const at of this.views.values()) {
      if (at !== null && now - at <= SEEN_FOR_MS) return true;
    }
    return false;
  }
}

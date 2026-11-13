/** How often a view asks the daemon for a pong. */
export const PING_EVERY_MS = 10_000;

/**
 * Whether a view's socket still reaches the daemon. A laptop waking from sleep, or a phone back
 * on its network, can hold a socket that looks open and goes nowhere. Each beat asks for a pong;
 * any frame from the daemon answers. One unanswered beat makes the socket `late`, which the view
 * warns of: a tab back from a freeze can run its timer before the pong already waiting for it,
 * and a slow link can take that long. Two in a row make it `dead`. The first beat after the page
 * is shown again doesn't count, for the same reason. It never measures time since the last frame:
 * a background tab's timers can fire as rarely as once a minute, and that would make a healthy
 * socket look dead.
 */
export class Heartbeat {
  private answered = true;
  private missed = 0;
  private resuming = false;

  /** Something arrived from the daemon. True if the socket had been late. */
  heard(): boolean {
    const wasLate = this.missed > 0;
    this.answered = true;
    this.missed = 0;
    return wasLate;
  }

  /** The page is shown again after being hidden. */
  resumed(): void {
    this.resuming = true;
  }

  beat(): "ping" | "late" | "dead" {
    if (!this.answered && !this.resuming) this.missed++;
    this.resuming = false;
    this.answered = false;
    if (this.missed >= 2) return "dead";
    return this.missed === 1 ? "late" : "ping";
  }
}

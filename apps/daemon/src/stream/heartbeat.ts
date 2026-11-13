/**
 * Whether a view is still there, judged once per beat. A view that answered neither the last
 * ping nor sent anything since is gone, unless output was queued for it since: then a ping waits
 * behind that output, so a phone working through a burst on a slow link can't answer in time,
 * and it gets `patience` beats. That holds after the daemon's queue empties too, since the last
 * of the output and the ping are still on their way. How much has gone out can't be told while
 * it drains (the socket reports its queue unchanged until the whole batch is written), so this
 * bounds the wait rather than tracking it. A view that can't keep up at all is the eviction's to end
 * (foundation-design §5.3).
 */
export class ViewHeartbeat {
  private unanswered = 0;
  private draining = false;
  private readonly patience: number;

  constructor(patience: number) {
    this.patience = patience;
  }

  /** The view answered a ping, or sent a frame. */
  heard(): void {
    this.unanswered = 0;
    this.draining = false;
  }

  beat(unsent: number): "ping" | "gone" {
    this.draining ||= unsent > 0;
    if (this.unanswered >= (this.draining ? this.patience : 1)) return "gone";
    this.unanswered++;
    return "ping";
  }
}

import type { WebSocket } from "ws";

/**
 * How often each WebSocket peer is pinged. One that is gone by `ViewHeartbeat`'s account is ended,
 * so a phone that slept or lost its network gives up its terminal's lease (foundation-design §4.3)
 * and its connection slot instead of holding them until its TCP connection times out.
 */
export const HEARTBEAT_MS = 15_000;

/**
 * Heartbeats a peer with output still queued may leave unanswered: two minutes, in which a phone
 * on a slow link drains far more than the eviction allows to queue.
 */
export const DRAIN_PATIENCE = 8;

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

/**
 * Pings `ws` every `ms` and ends it, after calling `gone`, once `ViewHeartbeat` judges it gone. A
 * pong or any message counts as an answer.
 */
export function keepAlive(
  ws: WebSocket,
  every: { readonly ms: number; readonly patience: number },
  gone?: () => void,
): void {
  const heart = new ViewHeartbeat(every.patience);
  const beat = setInterval(() => {
    if (heart.beat(ws.bufferedAmount) === "ping") return ws.ping();
    gone?.();
    ws.terminate();
  }, every.ms);
  beat.unref();
  ws.on("pong", () => heart.heard());
  ws.on("message", () => heart.heard());
  ws.on("close", () => clearInterval(beat));
}

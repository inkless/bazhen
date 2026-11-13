import { WebSocketServer, type RawData, type WebSocket } from "ws";
import { isId, type RuntimeRef } from "@bazhen/core";
import {
  EPOCH_FRAMES_SINCE,
  isAtLeast,
  isCompatible,
  parseJson,
  StreamClientFrame,
  type StreamServerFrame,
} from "@bazhen/protocol";
import type { UpgradeRoute } from "../http/upgrades.ts";
import { ViewHeartbeat } from "./heartbeat.ts";
import type { Attachment, LeaveReason, TerminalHub } from "./hub.ts";

/** A frame is a keystroke burst or a paste; nothing a person types comes near this. */
const MAX_FRAME_BYTES = 1 << 20;

/**
 * How often each view is pinged. One that is gone by `ViewHeartbeat`'s account is ended, so a
 * phone that slept or lost its network gives up the lease (foundation-design §4.3) instead of
 * holding it until its TCP connection times out.
 */
export const HEARTBEAT_MS = 15_000;

/**
 * Heartbeats a view with output still queued may leave unanswered: two minutes, in which a phone
 * on a slow link drains far more than the eviction allows to queue.
 */
export const DRAIN_PATIENCE = 8;

export interface StreamDeps {
  readonly hub: Pick<TerminalHub, "join">;
  readonly runtimeRef: (terminalId: string) => RuntimeRef | undefined;
  readonly heartbeatMs?: number;
  readonly drainPatience?: number;
}

/** The terminal stream's WebSocket endpoint (foundation-design §5.3). */
export function streamRoute(deps: StreamDeps): UpgradeRoute {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  return {
    path: /^\/v1\/terminals\/([^/]+)\/stream$/,
    upgrade: (req, socket, head, _url, [, terminalId = ""], device) =>
      wss.handleUpgrade(req, socket, head, (ws) => serve(deps, ws, terminalId, device?.name)),
  };
}

function serve(
  deps: StreamDeps,
  ws: WebSocket,
  terminalId: string,
  deviceName: string | undefined,
): void {
  const notify = (frame: StreamServerFrame) => ws.send(JSON.stringify(frame));
  const refuse = (message: string) => {
    notify({ type: "error", message });
    ws.close();
  };
  let attachment: Attachment | undefined;
  // Set as soon as a hello arrives, so a second one while the first joins starts nothing.
  let joining = false;
  let leaving: LeaveReason | undefined;
  const heart = new ViewHeartbeat(deps.drainPatience ?? DRAIN_PATIENCE);
  const beat = setInterval(() => {
    if (heart.beat(ws.bufferedAmount) === "ping") return ws.ping();
    leaving = "timed_out";
    ws.terminate();
  }, deps.heartbeatMs ?? HEARTBEAT_MS);
  beat.unref();
  ws.on("pong", () => heart.heard());
  ws.on("close", () => {
    clearInterval(beat);
    leaving ??= "client_closed";
    attachment?.leave(leaving);
  });
  ws.on("message", (data: RawData, binary: boolean) => {
    heart.heard();
    const bytes = toBuffer(data);
    if (binary) {
      attachment?.input(bytes);
      return;
    }
    const frame = StreamClientFrame.safeParse(parseJson(bytes.toString("utf8")));
    if (!frame.success) return refuse("unreadable frame");
    const f = frame.data;
    if (f.type === "hello") {
      if (joining) return;
      joining = true;
      if (!isCompatible(f.protocolVersion))
        return refuse(`protocol ${f.protocolVersion} is unsupported`);
      const ref = deps.runtimeRef(terminalId);
      if (ref === undefined) return refuse(`no running terminal ${terminalId}`);
      const viewer = {
        mode: f.mode,
        deviceName,
        declaresEpoch: isAtLeast(f.protocolVersion, EPOCH_FRAMES_SINCE),
        send: (out: Uint8Array) => ws.send(out, { binary: true }),
        notify,
        unsent: () => ws.bufferedAmount,
        close: () => ws.close(),
      };
      const claim = f.resumes;
      const resumes =
        claim !== undefined && isId("att", claim.attachmentId)
          ? { attachmentId: claim.attachmentId, token: claim.token }
          : undefined;
      deps.hub.join(ref, viewer, { cols: f.cols, rows: f.rows }, resumes).then(
        (joined) => {
          attachment = joined;
          if (leaving !== undefined) joined.leave(leaving);
        },
        (err: unknown) => refuse(`attach failed: ${String(err)}`),
      );
      return;
    }
    if (f.type === "engage") attachment?.engage();
    else if (f.type === "epoch") attachment?.declareEpoch(f.epoch);
    else if (f.type === "ping") notify({ type: "pong" });
    else attachment?.resize({ cols: f.cols, rows: f.rows });
  });
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

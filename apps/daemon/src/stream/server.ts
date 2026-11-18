import type { RawData, WebSocket } from "ws";
import { isId, type RuntimeRef } from "@bazhen/core";
import {
  parseJson,
  STREAM_FRAME_MAX_BYTES,
  StreamClientFrame,
  type StreamServerFrame,
} from "@bazhen/protocol";
import { failureDetail } from "../commands.ts";
import { ClosingBudget } from "../http/closing.ts";
import { heardWebSockets } from "../http/connections.ts";
import {
  closeTimeoutFor,
  DRAIN_PATIENCE,
  HEARTBEAT_MS,
  keepAlive,
  type Heartbeat,
} from "../http/heartbeat.ts";
import type { UpgradeRoute } from "../http/upgrades.ts";
import { ViewRefused, type Attachment, type LeaveReason, type TerminalHub } from "./hub.ts";

/**
 * The most bytes the stream's closed sockets may hold queued for their peers, across the daemon.
 * A terminal whose views are all dismissed at once, by a burst that evicts them or by its exit,
 * holds `maxViews` (16) × about 5 MiB (`maxUnsentBytes`, plus the snapshot piece in flight and
 * the chunk of output that tipped the view over): 80 MiB, which this keeps whole with room. It
 * stays under the hub's 200 MiB snapshot budget.
 */
export const MAX_CLOSING_BYTES = 128 * 1024 * 1024;

export const ANOTHER_PAGE = "this page is from another build of Bazhen than the daemon: reload it";

export interface StreamDeps {
  /** The daemon's protocol id: a view whose hello names another is refused. */
  readonly protocolId: string;
  readonly hub: Pick<TerminalHub, "join">;
  readonly runtimeRef: (terminalId: string) => RuntimeRef | undefined;
  readonly heartbeatMs?: number;
  readonly drainPatience?: number;
  readonly maxClosingBytes?: number;
}

/** The terminal stream's WebSocket endpoint (foundation-design §5.3). */
export function streamRoute(deps: StreamDeps): UpgradeRoute {
  const every = {
    ms: deps.heartbeatMs ?? HEARTBEAT_MS,
    patience: deps.drainPatience ?? DRAIN_PATIENCE,
  };
  const wss = heardWebSockets(STREAM_FRAME_MAX_BYTES, closeTimeoutFor(every));
  const closing = new ClosingBudget(deps.maxClosingBytes ?? MAX_CLOSING_BYTES);
  return {
    path: /^\/v1\/terminals\/([^/]+)\/stream$/,
    upgrade: (req, socket, head, _url, [, terminalId = ""], device) =>
      wss.handleUpgrade(req, socket, head, (ws) =>
        serve(deps, every, closing, ws, terminalId, device?.name),
      ),
  };
}

function serve(
  deps: StreamDeps,
  every: Heartbeat,
  closing: ClosingBudget,
  ws: WebSocket,
  terminalId: string,
  deviceName: string | undefined,
): void {
  const notify = (frame: StreamServerFrame) => ws.send(JSON.stringify(frame));
  const refuse = (message: string) => {
    notify({ type: "error", message });
    closing.close(ws);
  };
  let attachment: Attachment | undefined;
  // Set as soon as a hello arrives, so a second one while the first joins starts nothing.
  let joining = false;
  let leaving: LeaveReason | undefined;
  keepAlive(ws, every, () => (leaving = "timed_out"));
  ws.on("close", () => {
    leaving ??= "client_closed";
    attachment?.leave(leaving);
  });
  ws.on("message", (data: RawData, binary: boolean) => {
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
      if (f.protocolId !== deps.protocolId) return refuse(ANOTHER_PAGE);
      const ref = deps.runtimeRef(terminalId);
      if (ref === undefined) return refuse(`no running terminal ${terminalId}`);
      const viewer = {
        mode: f.mode,
        deviceName,
        send: (out: Uint8Array, written?: () => void) => ws.send(out, { binary: true }, written),
        notify,
        unsent: () => ws.bufferedAmount,
        close: () => closing.close(ws),
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
        (err: unknown) =>
          refuse(err instanceof ViewRefused ? err.message : `attach failed: ${failureDetail(err)}`),
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

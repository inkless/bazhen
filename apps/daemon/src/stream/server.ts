import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { RuntimeRef } from "@bazhen/core";
import { isCompatible, StreamClientFrame, type StreamServerFrame } from "@bazhen/protocol";
import type { UpgradeRoute } from "../http/upgrades.ts";
import type { Attachment, TerminalHub } from "./hub.ts";

/** A frame is a keystroke burst or a paste; nothing a person types comes near this. */
const MAX_FRAME_BYTES = 1 << 20;

export interface StreamDeps {
  readonly hub: Pick<TerminalHub, "join">;
  readonly runtimeRef: (terminalId: string) => RuntimeRef | undefined;
}

/** The terminal stream's WebSocket endpoint (foundation-design §5.3). */
export function streamRoute(deps: StreamDeps): UpgradeRoute {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  return {
    path: /^\/v1\/terminals\/([^/]+)\/stream$/,
    upgrade: (req, socket, head, _url, [, terminalId = ""]) =>
      wss.handleUpgrade(req, socket, head, (ws) => serve(deps, ws, terminalId)),
  };
}

function serve(deps: StreamDeps, ws: WebSocket, terminalId: string): void {
  const notify = (frame: StreamServerFrame) => ws.send(JSON.stringify(frame));
  const refuse = (message: string) => {
    notify({ type: "error", message });
    ws.close();
  };
  let attachment: Attachment | undefined;
  // Set as soon as a hello arrives, so a second one while the first joins starts nothing.
  let joining = false;
  let leaving = false;
  ws.on("close", () => {
    leaving = true;
    attachment?.leave();
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
      if (!isCompatible(f.protocolVersion))
        return refuse(`protocol ${f.protocolVersion} is unsupported`);
      const ref = deps.runtimeRef(terminalId);
      if (ref === undefined) return refuse(`no running terminal ${terminalId}`);
      const viewer = {
        mode: f.mode,
        send: (out: Uint8Array) => ws.send(out, { binary: true }),
        notify,
        close: () => ws.close(),
      };
      deps.hub.join(ref, viewer, { cols: f.cols, rows: f.rows }).then(
        (joined) => {
          attachment = joined;
          if (leaving) joined.leave();
        },
        (err: unknown) => refuse(`attach failed: ${String(err)}`),
      );
      return;
    }
    if (f.type === "engage") attachment?.engage();
    else attachment?.resize({ cols: f.cols, rows: f.rows });
  });
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  return Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import type { RuntimeRef } from "@bazhen/core";
import { isCompatible, StreamClientFrame, type StreamServerFrame } from "@bazhen/protocol";
import { refusal, type Allowlists } from "../http/guard.ts";
import type { Attachment, TerminalHub } from "./hub.ts";

const STREAM_PATH = /^\/v1\/terminals\/([^/]+)\/stream$/;

export interface StreamDeps {
  readonly allow: Allowlists;
  readonly hub: TerminalHub;
  readonly runtimeRef: (terminalId: string) => RuntimeRef | undefined;
}

/** The terminal stream's WebSocket endpoint (foundation-design §5.3); the only user of `ws`. */
export function streamUpgrades(deps: StreamDeps) {
  const wss = new WebSocketServer({ noServer: true });
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = new URL(req.url ?? "/", "http://daemon").pathname;
    const terminalId = STREAM_PATH.exec(path)?.[1];
    const { host, origin } = req.headers;
    const refused = refusal(deps.allow, { host, origin, acting: true });
    if (terminalId === undefined || refused !== null) {
      socket.end(`HTTP/1.1 ${refused === null ? "404 Not Found" : "403 Forbidden"}\r\n\r\n`);
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => serve(deps, ws, terminalId));
  };
}

function serve(deps: StreamDeps, ws: WebSocket, terminalId: string): void {
  const notify = (frame: StreamServerFrame) => ws.send(JSON.stringify(frame));
  const refuse = (message: string) => {
    notify({ type: "error", message });
    ws.close();
  };
  let attachment: Attachment | undefined;
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
      if (attachment !== undefined) return;
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

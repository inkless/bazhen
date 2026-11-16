import { WebSocketServer } from "ws";
import {
  ClientEventFrame,
  EVENT_FRAME_MAX_BYTES,
  EventStreamQuery,
  parseJson,
} from "@bazhen/protocol";
import { refuseUpgrade, type UpgradeRoute } from "../http/upgrades.ts";
import type { Store } from "../store/store.ts";
import type { Presence } from "../notify/presence.ts";
import { follow } from "./feed.ts";

/** RFC 6455's close code for a server that can't go on. */
const INTERNAL_ERROR = 1011;

/** The event stream's WebSocket endpoint, `/v1/events` (foundation-design §5.2). */
export function eventRoute(store: Store, presence?: Presence): UpgradeRoute {
  const wss = new WebSocketServer({ noServer: true, maxPayload: EVENT_FRAME_MAX_BYTES });
  return {
    path: /^\/v1\/events$/,
    upgrade: (req, socket, head, url) => {
      const query = EventStreamQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return refuseUpgrade(socket, "400 Bad Request");
      const cursor = { epoch: query.data.epoch, after: Number(query.data.after) };
      wss.handleUpgrade(req, socket, head, (ws) => {
        const stop = follow(store, cursor, {
          send: (frame, written) =>
            ws.send(JSON.stringify(frame), (err) => {
              // A failed write means the socket is going; its close stops the feed.
              if (err === undefined || err === null) written?.();
              else ws.terminate();
            }),
          close: () => ws.close(),
          fail: (err) => {
            console.error("an event stream failed", err);
            ws.close(INTERNAL_ERROR, "internal error");
          },
        });
        ws.on("message", (data: Buffer) => {
          // A frame this build doesn't know is skipped, as clients skip unknown events.
          const frame = ClientEventFrame.safeParse(parseJson(data.toString("utf8")));
          if (frame.success) presence?.report(ws, frame.data.visible, Date.now());
        });
        ws.on("close", () => {
          presence?.gone(ws);
          stop();
        });
      });
    },
  };
}

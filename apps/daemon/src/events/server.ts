import { WebSocketServer } from "ws";
import { EventStreamQuery, isCompatible } from "@bazhen/protocol";
import { refuseUpgrade, type UpgradeRoute } from "../http/upgrades.ts";
import type { Store } from "../store/store.ts";
import { follow } from "./feed.ts";

/** The client sends nothing on this stream. */
const MAX_FRAME_BYTES = 1024;

/** The event stream's WebSocket endpoint, `/v1/events` (foundation-design §5.2). */
export function eventRoute(store: Store): UpgradeRoute {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  return {
    path: /^\/v1\/events$/,
    upgrade: (req, socket, head, url) => {
      const query = EventStreamQuery.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success || !isCompatible(query.data.v))
        return refuseUpgrade(socket, "400 Bad Request");
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
        });
        ws.on("close", stop);
      });
    },
  };
}

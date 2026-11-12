import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { refusal, type Allowlists } from "./guard.ts";

/** The same statuses as the HTTP surface, so a refused upgrade reads like a refused request. */
const REFUSAL_STATUS = {
  host_not_allowed: "421 Misdirected Request",
  origin_not_allowed: "403 Forbidden",
};

/** A WebSocket endpoint: the path it serves, and what takes an upgrade the guard let through. */
export interface UpgradeRoute {
  readonly path: RegExp;
  readonly upgrade: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    match: RegExpExecArray,
  ) => void;
}

export function refuseUpgrade(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
}

/** The server's one `upgrade` listener: every WebSocket passes the Host and Origin guard. */
export function upgrades(allow: Allowlists, routes: readonly UpgradeRoute[]) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { host, origin } = req.headers;
    const refused = refusal(allow, { host, origin, acting: true });
    if (refused !== null) return refuseUpgrade(socket, REFUSAL_STATUS[refused]);
    const path = new URL(req.url ?? "/", "http://daemon").pathname;
    for (const route of routes) {
      const match = route.path.exec(path);
      if (match !== null) return route.upgrade(req, socket, head, match);
    }
    refuseUpgrade(socket, "404 Not Found");
  };
}

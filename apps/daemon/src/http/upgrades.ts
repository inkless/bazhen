import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { refusal, type Allowlists } from "./guard.ts";
import { tokenFrom, type DeviceAuth } from "../auth/devices.ts";

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
    url: URL,
    match: RegExpExecArray,
  ) => void;
}

export function refuseUpgrade(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
}

/**
 * The server's one `upgrade` listener: every WebSocket passes the Host and Origin guard and, given
 * `devices`, comes from a paired browser, which always sends Origin on an upgrade. The device
 * holds the socket, so revoking it closes the socket.
 */
export function upgrades(
  allow: Allowlists,
  routes: readonly UpgradeRoute[],
  devices: DeviceAuth | null = null,
) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { host, origin } = req.headers;
    const refused = refusal(allow, { host, origin, acting: true });
    if (refused !== null) return refuseUpgrade(socket, REFUSAL_STATUS[refused]);
    if (devices !== null) {
      const verified = devices.verify(tokenFrom(req.headers.cookie), { touch: false });
      if (verified === null) return refuseUpgrade(socket, "401 Unauthorized");
      if (origin === undefined) return refuseUpgrade(socket, REFUSAL_STATUS.origin_not_allowed);
      devices.hold(verified.device.id, socket);
    }
    const url = new URL(req.url ?? "/", "http://daemon");
    for (const route of routes) {
      const match = route.path.exec(url.pathname);
      if (match !== null) return route.upgrade(req, socket, head, url, match);
    }
    refuseUpgrade(socket, "404 Not Found");
  };
}

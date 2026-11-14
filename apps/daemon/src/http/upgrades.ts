import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { refusal, type Allowlists } from "./guard.ts";
import { arrivedRemotely, mustPair, tokenFrom, type DeviceGate } from "../auth/devices.ts";
import type { StoredDevice } from "../store/store.ts";

/** The same statuses as the HTTP surface, so a refused upgrade reads like a refused request. */
const REFUSAL_STATUS = {
  host_not_allowed: "421 Misdirected Request",
  origin_not_allowed: "403 Forbidden",
};

/**
 * A WebSocket endpoint: the path it serves, and what takes an upgrade the guard let through.
 * `device` is the paired device the upgrade came from, or null for a browser that never paired.
 */
export interface UpgradeRoute {
  readonly path: RegExp;
  readonly upgrade: (
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    url: URL,
    match: RegExpExecArray,
    device: StoredDevice | null,
  ) => void;
}

export function refuseUpgrade(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\n\r\n`);
}

/**
 * The server's one `upgrade` listener: every WebSocket passes the Host and Origin guard and, when
 * `gate` asks, comes from a paired browser, which always sends Origin on an upgrade. The device
 * holds the socket, so revoking it closes the socket.
 */
export function upgrades(
  allow: Allowlists,
  routes: readonly UpgradeRoute[],
  gate: DeviceGate | null = null,
) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const { host, origin } = req.headers;
    const refused = refusal(allow, { host, origin, acting: true });
    if (refused !== null) return refuseUpgrade(socket, REFUSAL_STATUS[refused]);
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value.join(", ") : value;
    };
    // A browser on loopback need not pair, but one that has is still known by its device.
    const verified =
      gate?.devices.verify(tokenFrom(req.headers.cookie), {
        touch: false,
        remote: arrivedRemotely(header),
      }) ?? null;
    const required = gate !== null && mustPair(gate, header);
    if (required) {
      if (verified === null) return refuseUpgrade(socket, "401 Unauthorized");
      if (origin === undefined) return refuseUpgrade(socket, REFUSAL_STATUS.origin_not_allowed);
    }
    // Held wherever it is named, so a revoked device can't go on being named, nor a lapsed one
    // where it had to pair.
    if (verified !== null) gate?.devices.hold(verified.device.id, socket, { required });
    const device = verified?.device ?? null;
    const url = new URL(req.url ?? "/", "http://daemon");
    for (const route of routes) {
      const match = route.path.exec(url.pathname);
      if (match !== null) return route.upgrade(req, socket, head, url, match, device);
    }
    refuseUpgrade(socket, "404 Not Found");
  };
}

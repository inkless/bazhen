import type { IncomingMessage } from "node:http";
import type { Socket } from "node:net";
import type { Duplex } from "node:stream";
import type { ErrorResponse } from "@bazhen/protocol";
import { refusal, type Allowlists } from "./guard.ts";
import { AGENT_ID_HEADER, AGENT_TOKEN_HEADER } from "../auth/agent-token.ts";
import { identify, type AgentCredentials } from "../auth/callers.ts";
import { arrivedRemotely, mustPair, tokenFrom, type DeviceGate } from "../auth/devices.ts";
import type { PeerReading } from "../auth/peer.ts";
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

/** Refuses an upgrade with 403 and the reason, as a forbidden request is answered. */
function forbidUpgrade(socket: Duplex, message: string): void {
  const body: ErrorResponse = { error: "forbidden", message };
  const text = JSON.stringify(body);
  socket.end(
    `HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n` +
      `Content-Length: ${Buffer.byteLength(text)}\r\nConnection: close\r\n\r\n${text}`,
  );
}

/**
 * The loopback and LAN servers' `upgrade` listener: every WebSocket passes the Host and Origin
 * guard and, when `gate` asks, comes from a paired browser, which always sends Origin on an
 * upgrade. The device holds the socket, so revoking it closes the socket.
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
        remote: arrivedRemotely(gate, header),
      }) ?? null;
    const required = gate !== null && mustPair(gate, header);
    if (required) {
      if (verified === null) return refuseUpgrade(socket, "401 Unauthorized");
      if (origin === undefined) return refuseUpgrade(socket, REFUSAL_STATUS.origin_not_allowed);
    }
    // Held wherever it is named, so a revoked device can't go on being named, nor a lapsed one
    // where it had to pair.
    if (verified !== null) gate?.devices.hold(verified.device.id, socket, { required });
    route(routes, req, socket, head, verified?.device ?? null);
  };
}

/**
 * The daemon socket's `upgrade` listener. The socket's 0600 mode is what admits a caller, so no
 * Host, Origin or pairing check applies; each caller is identified as every socket request is,
 * and only the human may open one: an agent could otherwise type into another agent's terminal.
 */
export function socketUpgrades(
  credentials: AgentCredentials,
  routes: readonly UpgradeRoute[],
  peer?: (connection: Socket) => Promise<PeerReading>,
) {
  return (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    // Node takes its own error listener off a socket it hands to `upgrade`, and ws adds one only
    // once a route takes the socket: a caller that hangs up while it is identified would
    // otherwise fail a refusal's write with nothing listening, and end the daemon.
    const dropped = () => socket.destroy();
    socket.on("error", dropped);
    const header = (name: string) => {
      const value = req.headers[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const presented = { token: header(AGENT_TOKEN_HEADER), said: header(AGENT_ID_HEADER) };
    void (peer === undefined ? Promise.resolve(undefined) : peer(req.socket)).then(
      (reading) => {
        const who = identify(credentials, presented, reading);
        if (who.kind === "human") {
          return route(routes, req, socket, head, null, () => socket.off("error", dropped));
        }
        forbidUpgrade(
          socket,
          who.kind === "refused" ? who.reason : "an agent can't attach to a terminal",
        );
      },
      () => forbidUpgrade(socket, "the caller's process can't be read for sure"),
    );
  };
}

/** Hands the upgrade to the route its path matches, calling `handOver` first, or refuses it. */
function route(
  routes: readonly UpgradeRoute[],
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  device: StoredDevice | null,
  handOver = () => {},
): void {
  const url = new URL(req.url ?? "/", "http://daemon");
  for (const r of routes) {
    const match = r.path.exec(url.pathname);
    if (match === null) continue;
    handOver();
    return r.upgrade(req, socket, head, url, match, device);
  }
  refuseUpgrade(socket, "404 Not Found");
}

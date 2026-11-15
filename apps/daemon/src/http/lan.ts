import { IncomingMessage } from "node:http";
import { Server, createServer } from "node:https";
import type { Duplex } from "node:stream";
import { serve } from "@hono/node-server";
import type { Context } from "hono";
import type { DeviceAuth } from "../auth/devices.ts";
import type { PairingCodes } from "../auth/pairing.ts";
import { admitted, type Cidr } from "../config/cidr.ts";
import type { LanCertificate } from "../tls/material.ts";
import { createApp, type AppDeps } from "./app.ts";
import { upgrades, type UpgradeRoute } from "./upgrades.ts";

/** A TLS handshake must finish this fast, so peers can't hold sockets open half-made. */
export const HANDSHAKE_MS = 10_000;
/** More than one household's browsers need; a cap on the descriptors peers on the LAN can hold. */
export const MAX_CONNECTIONS = 64;

/** The peer a request on the LAN listener came from, as its socket says, never a header. */
export function lanPeer(c: Context): string | undefined {
  const env: unknown = c.env;
  if (typeof env !== "object" || env === null || !("incoming" in env)) return undefined;
  return env.incoming instanceof IncomingMessage ? env.incoming.socket.remoteAddress : undefined;
}

export interface LanParts {
  /** The commands both listeners serve. */
  readonly commands: Omit<AppDeps, "allow" | "pairing" | "gate" | "lan" | "web">;
  readonly web?: AppDeps["web"];
  readonly devices: DeviceAuth;
  readonly codes: PairingCodes;
  readonly certificate: LanCertificate;
  /** 0 picks a free port, as tests do. */
  readonly port: number;
  /** Every interface unless set. */
  readonly hostname?: string;
  readonly allow: readonly Cidr[];
  readonly streams: readonly UpgradeRoute[];
  readonly limits?: { readonly handshakeMs?: number; readonly maxConnections?: number };
  /** How pairing knows its peer; tests stand in other addresses. */
  readonly peer?: (c: Context) => string | undefined;
  readonly listening?: (port: number) => void;
  /** The listener failed and closed; nothing else does. */
  readonly failed: (err: Error) => void;
}

/**
 * The LAN listener: HTTPS, TLS 1.3 only. It answers only as the host its certificate names, and
 * every request and upgrade must come from a device paired over HTTPS, whatever `web.pairing`
 * says. A peer outside `allow` is dropped as it connects, before the handshake, so it never sees
 * the certificate; that narrows who reaches pairing, and pairing is the authentication. An error
 * closes this listener alone.
 */
export function lanListener(parts: LanParts): Server {
  const allow: { hosts: string[]; origins: string[] } = { hosts: [], origins: [] };
  const gate = { devices: parts.devices, always: true, remote: true };
  const app = createApp({
    ...parts.commands,
    allow,
    pairing: { codes: parts.codes, devices: parts.devices },
    gate,
    lan: { peer: parts.peer ?? lanPeer },
    ...(parts.web === undefined ? {} : { web: parts.web }),
  });
  const server = serve(
    {
      fetch: app.fetch,
      port: parts.port,
      ...(parts.hostname === undefined ? {} : { hostname: parts.hostname }),
      createServer,
      serverOptions: {
        key: parts.certificate.key,
        cert: parts.certificate.cert,
        minVersion: "TLSv1.3",
        handshakeTimeout: parts.limits?.handshakeMs ?? HANDSHAKE_MS,
      },
    },
    (info) => {
      const host = `${parts.certificate.name}:${info.port}`;
      allow.hosts.push(host);
      allow.origins.push(`https://${host}`);
      parts.listening?.(info.port);
    },
  );
  if (!(server instanceof Server)) throw new TypeError("serve() made no HTTPS server");
  server.maxConnections = parts.limits?.maxConnections ?? MAX_CONNECTIONS;
  server.on("error", (err) => {
    parts.failed(err);
    server.close(() => {});
  });
  server.on("connection", (socket: Duplex & { remoteAddress?: string }) => {
    if (!admitted(parts.allow, socket.remoteAddress)) socket.destroy();
  });
  server.on("upgrade", upgrades(allow, parts.streams, gate));
  return server;
}

/** The address a browser opens for the LAN listener. */
export const lanUrl = (cert: LanCertificate, port: number) => `https://${cert.name}:${port}`;

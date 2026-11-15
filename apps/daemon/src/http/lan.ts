import { IncomingMessage } from "node:http";
import { Server, createServer } from "node:https";
import type { Duplex } from "node:stream";
import { serve } from "@hono/node-server";
import type { Context, Hono } from "hono";
import { admitted, type Cidr } from "../config/cidr.ts";
import type { LanCertificate } from "../tls/material.ts";
import type { Allowlists } from "./guard.ts";

/** The one host the LAN listener answers as: the name its certificate is for, on its port. */
export function lanAllowlists(name: string, port: number): Allowlists {
  const host = `${name}:${port}`;
  return { hosts: [host], origins: [`https://${host}`] };
}

/** The peer a request on the LAN listener came from, as its socket says, never a header. */
export function lanPeer(c: Context): string | undefined {
  const env: unknown = c.env;
  if (typeof env !== "object" || env === null || !("incoming" in env)) return undefined;
  return env.incoming instanceof IncomingMessage ? env.incoming.socket.remoteAddress : undefined;
}

/**
 * The LAN listener: HTTPS, TLS 1.3 only, on every interface unless `hostname` narrows it. A peer
 * outside `allow` is dropped as it connects, before the handshake, so it never sees the
 * certificate. This narrows who can reach pairing; pairing is the authentication.
 */
export function serveLan(opts: {
  readonly app: Hono;
  readonly certificate: LanCertificate;
  readonly port: number;
  readonly hostname?: string;
  readonly allow: readonly Cidr[];
  readonly upgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void;
  readonly listening?: (port: number) => void;
}): Server {
  const server = serve(
    {
      fetch: opts.app.fetch,
      port: opts.port,
      ...(opts.hostname === undefined ? {} : { hostname: opts.hostname }),
      createServer,
      serverOptions: {
        key: opts.certificate.key,
        cert: opts.certificate.cert,
        minVersion: "TLSv1.3",
      },
    },
    (info) => opts.listening?.(info.port),
  );
  if (!(server instanceof Server)) throw new TypeError("serve() made no HTTPS server");
  server.on("connection", (socket: Duplex & { remoteAddress?: string }) => {
    if (!admitted(opts.allow, socket.remoteAddress)) socket.destroy();
  });
  server.on("upgrade", opts.upgrade);
  return server;
}

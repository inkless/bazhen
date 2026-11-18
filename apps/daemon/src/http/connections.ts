import type { IncomingMessage } from "node:http";
import type { Server } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";

const hear = (socket: Duplex) => {
  socket.on("error", () => socket.destroy());
};

/**
 * `server`, with an `error` listener on each connection from the moment it is accepted, which
 * destroys it. Node's HTTP server hears a connection only while it owns it, and drops its
 * listener at an upgrade: a peer that resets one held between owners would end this process.
 * Over TLS the stream read is the secure one, so that is heard too.
 */
export function hearConnections<S extends Server>(server: S): S {
  server.prependListener("connection", hear);
  server.prependListener("secureConnection", hear);
  return server;
}

/** What a WebSocket route needs of its server: the upgrade, handing on a socket already heard. */
export interface HeardWebSockets {
  handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
    serve: (ws: WebSocket) => void,
  ): void;
}

/**
 * A server for WebSockets upgraded from the daemon's HTTP servers, each frames of which may be
 * `maxPayload` bytes at most, which hears each socket and terminates it on an error before its
 * route serves it. A socket the daemon closes is destroyed if its peer hasn't answered within
 * `closeTimeout` ms. ws reports a frame it refuses (one too large, text that isn't UTF-8, an
 * opcode it doesn't know) as an `error` on the socket, so a client can send one at will.
 */
export function heardWebSockets(maxPayload: number, closeTimeout: number): HeardWebSockets {
  const wss = new WebSocketServer({ noServer: true, maxPayload, closeTimeout });
  return {
    handleUpgrade: (req, socket, head, serve) =>
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.on("error", () => ws.terminate());
        serve(ws);
      }),
  };
}

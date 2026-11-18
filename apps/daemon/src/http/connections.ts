import type { Server } from "node:net";
import type { Duplex } from "node:stream";

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

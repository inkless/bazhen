import type { IncomingMessage } from "node:http";

declare module "ws" {
  namespace WebSocket {
    /** ws 8.22 takes `closeTimeout`; `@types/ws` 8.18 doesn't declare it. */
    interface ServerOptions<
      U extends typeof WebSocket.WebSocket = typeof WebSocket.WebSocket,
      V extends typeof IncomingMessage = typeof IncomingMessage,
    > {
      /** How long a socket the server closes waits for its peer's close before it is destroyed. */
      closeTimeout?: number | undefined;
    }
  }
}

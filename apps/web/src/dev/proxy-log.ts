/** How Vite's proxy opens each error a WebSocket it pipes raises. */
const WS_PROXY_ERRORS = ["ws proxy error:", "ws proxy socket error:"];

/** A read or write on a socket whose other end has already gone. */
const PEER_GONE = new Set(["EPIPE", "ECONNRESET"]);

/**
 * A socket's own read or write failed, which names its syscall. A daemon that closes during the
 * handshake is ECONNRESET too, as "socket hang up", but names none, so it still prints. One that
 * resets during it reads as a reset mid-stream, and doesn't; a daemon that is down refuses.
 */
const peerGone = (error: unknown) =>
  error instanceof Error &&
  "code" in error &&
  PEER_GONE.has(String(error.code)) &&
  "syscall" in error &&
  typeof error.syscall === "string";

/**
 * Whether an error Vite logs is its proxy writing into a terminal stream's socket after the other
 * end went: a browser tab closing, or the daemon restarting, while the other end still sends. Vite
 * logs that one failure twice, each with a stack. Any other error is not, a daemon that refuses or
 * closes during the handshake included.
 */
export function isClosedSocketError(msg: string, options?: { error?: unknown }): boolean {
  const head = msg.split("\n", 1)[0] ?? "";
  return WS_PROXY_ERRORS.some((opening) => head.includes(opening)) && peerGone(options?.error);
}

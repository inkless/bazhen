import { once } from "node:events";
import { existsSync, readdirSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { encodeHolderRequest, HOLDER_PROTOCOL_VERSION } from "@bazhen/protocol";

/**
 * The socket of each holder under a daemon's `home`, as the daemon's holder runtime binds them. A
 * holder runs on after its daemon, as a terminal should.
 */
export function holderSockets(home: string): string[] {
  const dir = join(home, "run", "holders");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".sock"))
    .map((name) => join(dir, name));
}

/**
 * Ends a terminal by its holder's own protocol, from outside the daemon, and resolves once the
 * holder hangs up: nothing is signalled. A holder answers one connection's requests in order, so
 * `close` is sent straight after `hello`, its replies unread.
 */
export async function closeHolderAt(socket: string): Promise<void> {
  const connection = createConnection(socket);
  const ended = once(connection, "close");
  connection.on("error", () => {});
  connection.write(
    encodeHolderRequest({ type: "hello", id: 1, body: { protocol: [HOLDER_PROTOCOL_VERSION] } }),
  );
  connection.write(encodeHolderRequest({ type: "close", id: 2 }));
  connection.resume();
  const timer = setTimeout(() => connection.destroy(new Error(`${socket} didn't close`)), 5_000);
  await ended.finally(() => clearTimeout(timer));
}

/** Ends every holder still answering under a daemon's `home`, each by its own protocol. */
export async function closeHoldersUnder(home: string): Promise<void> {
  await Promise.all(
    holderSockets(home).map((socket) =>
      // A socket a holder that died left behind has nothing to close.
      closeHolderAt(socket).catch(() => {}),
    ),
  );
}

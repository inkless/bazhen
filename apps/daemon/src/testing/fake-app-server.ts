// A stand-in for Codex's app-server on a unix socket, for the medium tests of the daemon's client.

import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { WebSocketServer } from "ws";
import { z } from "zod";

const Request = z.object({
  id: z.number().optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

const dirs: string[] = [];
const servers: Server[] = [];

/** Closes every fake server and removes every home made since the last call. */
export function closeFakeServers(): void {
  for (const s of servers.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** A Codex home, with the path its managed daemon's socket would have. */
export function tempCodexHome() {
  // Short, under /tmp: a unix socket path must fit in 104 bytes.
  const dir = realpathSync(mkdtempSync("/tmp/bz-codex-"));
  dirs.push(dir);
  mkdirSync(join(dir, "app-server-control"));
  return { codexHome: dir, socket: join(dir, "app-server-control", "app-server-control.sock") };
}

/**
 * A stand-in app-server on `socket`: it answers `initialize` for `codexHome` as `version`, and
 * every other request with `answer`, told which connection (from 0) it came on and with what
 * params; an `andSends` beside the result is a message the server sends of its own accord
 * right after. Where `answer` returns nothing it ends the connection without a close frame.
 */
export async function fakeServer(
  socket: string,
  codexHome: string,
  answer: (
    method: string,
    connection: number,
    params: unknown,
  ) => object | null | undefined = () => ({
    result: {},
  }),
  version = "0.166.0",
): Promise<{ wss: WebSocketServer; replies: unknown[]; close(): Promise<void> }> {
  const http = createServer();
  servers.push(http);
  const wss = new WebSocketServer({ server: http });
  let connections = 0;
  // What the client sent that isn't a request: its replies to the server's own requests.
  const replies: unknown[] = [];
  wss.on("connection", (ws) => {
    const connection = connections++;
    ws.on("message", (data: Buffer) => {
      const json: unknown = JSON.parse(data.toString());
      const parsed = Request.safeParse(json);
      if (!parsed.success) {
        replies.push(json);
        return;
      }
      const m = parsed.data;
      if (m.id === undefined) return;
      const reply =
        m.method === "initialize"
          ? { result: { userAgent: `bazhen/${version} (Mac OS 26.7.1; arm64)`, codexHome } }
          : answer(m.method, connection, m.params);
      if (reply === null || reply === undefined) return ws.terminate();
      const { andSends, ...answered } = reply as { andSends?: object };
      ws.send(JSON.stringify({ id: m.id, ...answered }));
      if (andSends !== undefined) ws.send(JSON.stringify(andSends));
    });
  });
  await new Promise<void>((resolve) => http.listen(socket, resolve));
  const close = async () => {
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => http.close(resolve));
  };
  return { wss, replies, close };
}

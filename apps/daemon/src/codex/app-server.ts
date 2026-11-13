import { once } from "node:events";
import { realpathSync } from "node:fs";
import { WebSocket } from "ws";
import { RequestId } from "@bazhen/harness-codex";
import { z } from "zod";

/** A JSON-RPC error from the app-server, such as `serverShuttingDown` during a drain. */
export class AppServerError extends Error {
  readonly code: number;
  /** The `data.reason` Codex adds to some errors. */
  readonly reason: string | undefined;

  constructor(method: string, error: z.infer<typeof RpcError>) {
    super(`${method}: ${error.message} (${error.code})`);
    this.code = error.code;
    this.reason = error.data?.reason;
  }

  /**
   * The server is draining before it exits, for a restart, a stop or an update: the request
   * should go to the server that comes next (foundation-design §5.8).
   */
  get shuttingDown(): boolean {
    return this.reason === "serverShuttingDown";
  }
}

/** A server that answers for a different Codex home than the one Bazhen was started with. */
export class WrongCodexHome extends Error {
  constructor(expected: string, found: string) {
    super(`the app-server belongs to ${found}, not ${expected}`);
  }
}

const RpcError = z.object({
  code: z.number(),
  message: z.string(),
  data: z.object({ reason: z.string().optional() }).optional().catch(undefined),
});

/** A reply to one of Bazhen's requests. */
const Reply = z.object({
  id: z.number(),
  result: z.unknown().optional(),
  error: RpcError.optional(),
});

/** A request from the server, which carries an id to answer, or a notification, which has none. */
const Inbound = z.object({
  id: RequestId.optional(),
  method: z.string(),
  params: z.unknown().optional(),
});

/** What the server sends of its own accord. */
export interface Listener {
  /** A request the server waits on; `respond` answers it on the connection it came on. */
  request(method: string, params: unknown, id: RequestId, respond: (result: unknown) => void): void;
  notification(method: string, params: unknown): void;
}

const Initialized = z.object({ codexHome: z.string(), userAgent: z.string() });

interface Pending {
  readonly method: string;
  readonly timer: ReturnType<typeof setTimeout>;
  resolve(result: unknown): void;
  reject(err: Error): void;
}

/** How long one request may wait for its reply, and the socket for its WebSocket upgrade. */
const REQUEST_TIMEOUT_MS = 30_000;
const OPEN_TIMEOUT_MS = 10_000;

/**
 * One connection to Codex's app-server, JSON-RPC over a WebSocket on its unix socket
 * (foundation-design §5.8). It is open from `initialize` until the socket ends; the server exits
 * without a close frame, so a bare end is the disconnect, and every request in flight fails.
 */
export class AppServer {
  /** Resolves when the connection has ended, for whatever reason. */
  readonly closed: Promise<void>;
  private readonly ws: WebSocket;
  private readonly pending = new Map<number, Pending>();
  private nextId = 0;
  private serverVersion: string | null = null;
  private listener: Listener | undefined;

  private constructor(ws: WebSocket) {
    this.ws = ws;
    this.closed = new Promise((resolve) => ws.once("close", () => resolve()));
    ws.on("message", (data: Buffer) => this.receive(data.toString("utf8")));
    ws.on("close", () => this.failAll(new Error("the app-server connection ended")));
    ws.on("error", () => ws.terminate());
  }

  /**
   * The server's version. `initialize` has no field for it: it is the token after the client's
   * name in `userAgent` (`bazhen/0.166.0 (Mac OS 26.7.1; arm64) …`), or null if it names none.
   */
  get version(): string | null {
    return this.serverVersion;
  }

  /**
   * Connects and runs `initialize`, refusing a server for any Codex home but `codexHome`, which
   * the caller has resolved to its real path.
   */
  static async connect(socket: string, codexHome: string): Promise<AppServer> {
    const ws = new WebSocket(`ws+unix://${socket}:/`);
    try {
      await once(ws, "open", { signal: AbortSignal.timeout(OPEN_TIMEOUT_MS) });
    } catch (err) {
      ws.terminate();
      throw err;
    }
    const server = new AppServer(ws);
    try {
      const { codexHome: found, userAgent } = Initialized.parse(
        await server.request("initialize", {
          clientInfo: { name: "bazhen", version: "0" },
          capabilities: { experimentalApi: true },
        }),
      );
      if (realPath(found) !== codexHome) throw new WrongCodexHome(codexHome, found);
      server.serverVersion = /^[^/\s]+\/(\S+)/.exec(userAgent)?.[1] ?? null;
      server.send({ method: "initialized" });
      return server;
    } catch (err) {
      server.close();
      throw err;
    }
  }

  /** Where the server's requests and notifications go, from now on. */
  listen(listener: Listener): void {
    this.listener = listener;
  }

  get open(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  request(method: string, params: unknown): Promise<unknown> {
    if (!this.open) return Promise.reject(new Error(`${method}: the app-server is not connected`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.settle(id)?.reject(new Error(`${method}: no reply in ${REQUEST_TIMEOUT_MS} ms`)),
        REQUEST_TIMEOUT_MS,
      );
      this.pending.set(id, { method, timer, resolve, reject });
      this.send({ id, method, params });
    });
  }

  close(): void {
    this.ws.terminate();
  }

  private send(message: object): void {
    this.ws.send(JSON.stringify(message));
  }

  private receive(text: string): void {
    const json = parseJson(text);
    if (typeof json === "object" && json !== null && "method" in json) {
      const inbound = Inbound.safeParse(json);
      if (inbound.success) this.dispatch(inbound.data);
      return;
    }
    const reply = Reply.safeParse(json);
    if (!reply.success) return;
    const pending = this.settle(reply.data.id);
    const { error, result } = reply.data;
    if (error === undefined) pending?.resolve(result);
    else pending?.reject(new AppServerError(pending.method, error));
  }

  private dispatch({ id, method, params }: z.infer<typeof Inbound>): void {
    if (id === undefined) this.listener?.notification(method, params);
    else this.listener?.request(method, params, id, (result) => this.send({ id, result }));
  }

  /** Takes a request off the pending list, for its reply, its timeout or the end. */
  private settle(id: number): Pending | undefined {
    const pending = this.pending.get(id);
    if (pending === undefined) return undefined;
    clearTimeout(pending.timer);
    this.pending.delete(id);
    return pending;
  }

  private failAll(err: Error): void {
    for (const id of this.pending.keys()) this.settle(id)?.reject(err);
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A path with its symlinks resolved, or as given if it doesn't exist. */
export function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

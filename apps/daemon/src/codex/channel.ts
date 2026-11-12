import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HarnessChannelPort } from "@bazhen/core";
import { AppServer, AppServerError, realPath, type Listener } from "./app-server.ts";

/** What each connection's server sends of its own accord, and when connections come and go. */
export interface ChannelListener extends Listener {
  /** A connection ended; whatever it held may come again on the next. */
  disconnected(): void;
  /** A connection that is still open resumed these threads, and has sent what it holds of them. */
  resumed(threads: readonly string[]): void;
}

const run = promisify(execFile);

/** The Codex home agents use: the user's own, unless the environment names another. */
export const codexHomeOf = (env: Readonly<Record<string, string | undefined>>, home: string) =>
  env["CODEX_HOME"] ?? join(home, ".codex");

/** The Codex CLI on the home `env` names, with a time limit; it rejects if the command fails. */
export const codexCli =
  (env: Readonly<Record<string, string>>) =>
  (args: readonly string[]): Promise<void> =>
    run("codex", args, { env, timeout: 60_000 }).then(() => undefined);

/** The managed app-server's control socket in a Codex home. */
const socketIn = (codexHome: string) =>
  join(codexHome, "app-server-control", "app-server-control.sock");

/** The app-server, as Codex's own clients reach it with `--remote`. */
export const appServerAddress = (codexHome: string) => `unix://${socketIn(codexHome)}`;

export interface CodexChannelOptions {
  readonly codexHome: string;
  /** Starts Codex's own managed daemon when nothing listens. */
  readonly startDaemon: () => Promise<void>;
  /** The threads of the agents Bazhen runs, each resumed on every new connection. */
  readonly boundThreads: () => readonly string[];
  readonly listener?: ChannelListener;
  readonly log?: (message: string) => void;
  /** The first wait before reconnecting after a connection ends; it doubles to a minute. */
  readonly reconnectMs?: number;
}

/** How many servers a request is tried on when each is draining as it arrives. */
const DRAINING_ATTEMPTS = 3;

const MAX_RECONNECT_MS = 60_000;
/** A connection that lasted this long was a good one: the next one is tried at once again. */
const STABLE_MS = 30_000;

/**
 * The wait before the next connection, after one that failed or `lived` ms: it doubles up to a
 * cap, so a server that accepts and drops at once isn't dialled every second, and starts again
 * from `first` after a connection that held.
 */
export function nextDelay(current: number, lived: number | null, first: number): number {
  return lived !== null && lived >= STABLE_MS ? first : Math.min(current * 2, MAX_RECONNECT_MS);
}

/**
 * Codex's managed app-server on one Codex home (foundation-design §5.8), connected on first use.
 * When nothing listens, Codex's own daemon is started; Bazhen never runs a server of its own,
 * which would share the home's stores. A connection that ends is made again, with backoff, for
 * as long as any thread is bound: nothing announces a server's restart or self-update, and only
 * a subscribed client gets its threads' approvals.
 */
export class CodexChannel implements HarnessChannelPort {
  /** Where Codex's own clients reach the same server, as a TUI's `--remote`. */
  readonly address: string;
  private readonly opts: CodexChannelOptions;
  private readonly codexHome: string;
  private readonly socket: string;
  private readonly log: (message: string) => void;
  private connection: Promise<AppServer> | undefined;
  private current: AppServer | undefined;
  private lastVersion: string | undefined;
  private readonly firstRetryMs: number;
  private retryMs: number;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private closing = false;

  constructor(opts: CodexChannelOptions) {
    this.opts = opts;
    this.codexHome = realPath(opts.codexHome);
    this.socket = socketIn(opts.codexHome);
    this.address = appServerAddress(opts.codexHome);
    this.log = opts.log ?? console.warn;
    this.firstRetryMs = opts.reconnectMs ?? 1000;
    this.retryMs = this.firstRetryMs;
  }

  /**
   * One request's result. A server draining before it exits refuses new work, so the request
   * waits for that server to go and is sent to the next one.
   */
  async request(method: string, params: unknown): Promise<unknown> {
    for (let attempt = 1; ; attempt++) {
      const server = await this.connected();
      try {
        return await server.request(method, params);
      } catch (err) {
        if (!(err instanceof AppServerError && err.shuttingDown) || attempt >= DRAINING_ATTEMPTS) {
          throw err;
        }
        await server.closed;
      }
    }
  }

  /**
   * Connects now, if any thread is bound, so its approvals reach the inbox without waiting for a
   * request, and keeps trying with backoff until a connection holds.
   */
  keepConnected(): void {
    this.attempt(0);
  }

  close(): void {
    this.closing = true;
    clearTimeout(this.retry);
    this.current?.close();
    // A connection still being made is closed once it is.
    void this.connection?.then(
      (server) => server.close(),
      () => undefined,
    );
  }

  private connected(): Promise<AppServer> {
    this.connection ??= this.connect().then(
      (server) => {
        this.current = server;
        const opened = Date.now();
        void server.closed.then(() => {
          this.connection = undefined;
          const wait = this.retryMs;
          this.retryMs = nextDelay(this.retryMs, Date.now() - opened, this.firstRetryMs);
          this.attempt(wait);
        });
        return server;
      },
      (err: unknown) => {
        this.connection = undefined;
        throw err;
      },
    );
    return this.connection;
  }

  private attempt(delayMs: number): void {
    if (this.closing || this.opts.boundThreads().length === 0) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => {
      this.connected().catch((err: unknown) => {
        this.log(`codex: could not connect: ${String(err)}`);
        const wait = this.retryMs;
        this.retryMs = nextDelay(this.retryMs, null, this.firstRetryMs);
        this.attempt(wait);
      });
    }, delayMs);
  }

  private async connect(): Promise<AppServer> {
    const server = await this.dial();
    // Before any resume: a resumed thread's pending approvals are sent again at once.
    const listener = this.opts.listener;
    if (listener !== undefined) {
      server.listen(listener);
      void server.closed.then(() => listener.disconnected());
    }
    if (this.lastVersion !== undefined && server.version !== this.lastVersion) {
      this.log(`codex app-server updated from ${this.lastVersion} to ${server.version}`);
    }
    this.lastVersion = server.version;
    // Only a client that started or resumed a thread receives its events and approvals, and a
    // thread with no subscriber unloads; after any reconnect, every bound thread is resumed.
    const resumed: string[] = [];
    for (const threadId of this.opts.boundThreads()) {
      await server.request("thread/resume", { threadId, excludeTurns: true }).then(
        () => resumed.push(threadId),
        (err: unknown) => this.log(`codex thread ${threadId} could not be resumed: ${String(err)}`),
      );
    }
    // A connection that dropped mid-resume has told nothing: what it held may come again.
    if (server.open) listener?.resumed(resumed);
    return server;
  }

  private async dial(): Promise<AppServer> {
    try {
      return await AppServer.connect(this.socket, this.codexHome);
    } catch (err) {
      if (!nothingListens(err)) throw err;
    }
    await this.opts.startDaemon();
    return AppServer.connect(this.socket, this.codexHome);
  }
}

/** No socket, or one nobody accepts on: no server is running. */
const nothingListens = (err: unknown) =>
  err instanceof Error && "code" in err && (err.code === "ENOENT" || err.code === "ECONNREFUSED");

/** One listener that tells each of `listeners` whatever each listens for. */
export const allOf = (...listeners: Partial<ChannelListener>[]): ChannelListener => ({
  request: (method, params, id, respond) => {
    for (const l of listeners) l.request?.(method, params, id, respond);
  },
  notification: (method, params) => {
    for (const l of listeners) l.notification?.(method, params);
  },
  disconnected: () => {
    for (const l of listeners) l.disconnected?.();
  },
  resumed: (threads) => {
    for (const l of listeners) l.resumed?.(threads);
  },
});

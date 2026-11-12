import { execFile } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HarnessChannelPort } from "@bazhen/core";
import { AppServer, AppServerError, realPath } from "./app-server.ts";

const run = promisify(execFile);

/** The Codex home agents use: the user's own, unless the environment names another. */
export const codexHomeOf = (env: Readonly<Record<string, string | undefined>>, home: string) =>
  env["CODEX_HOME"] ?? join(home, ".codex");

/** Starts Codex's own managed daemon on the home `env` names, from the local CLI. */
export const startCodexDaemon = (env: Readonly<Record<string, string>>) =>
  run("codex", ["app-server", "daemon", "start"], { env, timeout: 60_000 }).then(() => undefined);

export interface CodexChannelOptions {
  readonly codexHome: string;
  /** Starts Codex's own managed daemon when nothing listens. */
  readonly startDaemon: () => Promise<void>;
  /** The threads of the agents Bazhen runs, each resumed on every new connection. */
  readonly boundThreads: () => readonly string[];
  readonly log?: (message: string) => void;
}

/** How many servers a request is tried on when each is draining as it arrives. */
const DRAINING_ATTEMPTS = 3;

/**
 * Codex's managed app-server on one Codex home (foundation-design §5.8), connected on first use
 * and again on the first use after the connection ends. When nothing listens, Codex's own daemon
 * is started; Bazhen never runs a server of its own, which would share the home's stores.
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

  constructor(opts: CodexChannelOptions) {
    this.opts = opts;
    this.codexHome = realPath(opts.codexHome);
    this.socket = join(opts.codexHome, "app-server-control", "app-server-control.sock");
    this.address = `unix://${this.socket}`;
    this.log = opts.log ?? console.warn;
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

  /** Connects now, so the bound threads are resumed without waiting for a request. */
  resume(): Promise<void> {
    return this.connected().then(() => undefined);
  }

  close(): void {
    this.current?.close();
  }

  private connected(): Promise<AppServer> {
    this.connection ??= this.connect().then(
      (server) => {
        this.current = server;
        void server.closed.then(() => (this.connection = undefined));
        return server;
      },
      (err: unknown) => {
        this.connection = undefined;
        throw err;
      },
    );
    return this.connection;
  }

  private async connect(): Promise<AppServer> {
    const server = await this.dial();
    if (this.lastVersion !== undefined && server.version !== this.lastVersion) {
      this.log(`codex app-server updated from ${this.lastVersion} to ${server.version}`);
    }
    this.lastVersion = server.version;
    // Only a client that started or resumed a thread receives its events and approvals, and a
    // thread with no subscriber unloads; after any reconnect, every bound thread is resumed.
    for (const threadId of this.opts.boundThreads()) {
      await server.request("thread/resume", { threadId, excludeTurns: true }).catch((err) => {
        this.log(`codex thread ${threadId} could not be resumed: ${String(err)}`);
      });
    }
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

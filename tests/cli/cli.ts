// The `bazhen` CLI as a process, against a fake daemon on the socket it looks for. The suite
// holds the CLI's verbs, what it sends, what it prints and how it exits, whatever language the CLI
// is written in: `BAZHEN_CLI` names the binary to run, and without it the Node CLI runs.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const NODE_CLI = join(repo, "apps/cli/src/main.ts");
/** Far past any call the CLI makes here, so a hung CLI fails its test rather than the run. */
const RUN_MS = 20_000;

/** A request the fake daemon received. */
export interface Received {
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body: unknown;
}

/** A protocol schema, as far as checking a canned reply needs one. */
interface Schema<T> {
  parse(value: unknown): T;
}

interface Reply {
  readonly status: number;
  readonly body: string;
}

/**
 * The daemon's socket, answering each route with a canned reply and recording every request.
 * A route it wasn't given answers 404, as the daemon does.
 */
export class FakeDaemon {
  readonly received: Received[] = [];
  readonly #routes = new Map<string, (r: Received) => Reply>();
  readonly #server: Server;

  private constructor(server: Server) {
    this.#server = server;
  }

  static async listen(socket: string): Promise<FakeDaemon> {
    const server = createServer();
    const daemon = new FakeDaemon(server);
    server.on("request", (req, res) => {
      let text = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (text += chunk));
      req.on("end", () => {
        const received = {
          method: req.method ?? "",
          path: req.url ?? "",
          headers: req.headers,
          body: text === "" ? undefined : JSON.parse(text),
        };
        daemon.received.push(received);
        const route = daemon.#routes.get(`${received.method} ${received.path}`);
        const reply = route?.(received) ?? {
          status: 404,
          body: JSON.stringify({ error: "not_found", message: `no route ${received.path}` }),
        };
        res.writeHead(reply.status, { "content-type": "application/json" });
        res.end(reply.body);
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    return daemon;
  }

  /** Answers `route` ("GET /v1/state") with `value`, checked against the reply's schema. */
  answer<T>(route: string, schema: Schema<T>, value: T): this {
    return this.answerWith(route, schema, () => value);
  }

  /** Answers `route` with what `make` makes of each request, checked against the schema. */
  answerWith<T>(route: string, schema: Schema<T>, make: (r: Received) => T): this {
    this.#routes.set(route, (r) => ({ status: 200, body: JSON.stringify(schema.parse(make(r))) }));
    return this;
  }

  /** Answers `route` with a status and body as they are, as a daemon refusing a command does. */
  fail(route: string, status: number, body: unknown): this {
    this.#routes.set(route, () => ({ status, body: JSON.stringify(body) }));
    return this;
  }

  /** The requests to `route` ("POST /v1/tasks"), in the order they came. */
  calls(route: string): Received[] {
    return this.received.filter((r) => `${r.method} ${r.path}` === route);
  }

  /** The routes the CLI called, in order. */
  routes(): string[] {
    return this.received.map((r) => `${r.method} ${r.path}`);
  }

  /** Stops answering: the socket refuses connections from now on, as a stopped daemon's does. */
  async close(): Promise<void> {
    if (!this.#server.listening) return;
    this.#server.closeAllConnections();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}

export interface Ran {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface Scene {
  /** `BAZHEN_HOME`, under which the CLI looks for the daemon's socket. */
  readonly home: string;
  /** A directory of the scene's own, to run the CLI in and keep files the CLI reads. */
  readonly dir: string;
  /** The socket the CLI finds from `home`. */
  readonly socket: string;
  readonly daemon: FakeDaemon;
  /** Runs `bazhen <args>` in `dir`, with `env` over the scene's own environment. */
  readonly bazhen: (args: readonly string[], env?: Record<string, string>) => Promise<Ran>;
  readonly cleanup: () => Promise<void>;
}

/** A fresh home with a fake daemon on its socket, and nothing of the test run's environment. */
export async function scene(): Promise<Scene> {
  const root = realpathSync(mkdtempSync("/tmp/bz-cli-"));
  const home = join(root, "home");
  const dir = join(root, "work");
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  mkdirSync(dir);
  const socket = join(home, "run", "bazhen.sock");
  const daemon = await FakeDaemon.listen(socket);
  const base = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: root, BAZHEN_HOME: home };
  return {
    home,
    dir,
    socket,
    daemon,
    bazhen: (args, env = {}) => run(args, { ...base, ...env }, dir),
    cleanup: async () => {
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function run(args: readonly string[], env: Record<string, string>, cwd: string): Promise<Ran> {
  const binary = process.env["BAZHEN_CLI"];
  const [file, argv] =
    binary === undefined || binary === ""
      ? [process.execPath, [NODE_CLI, ...args]]
      : [binary, [...args]];
  return new Promise((resolve, reject) => {
    execFile(file, argv, { env, cwd, timeout: RUN_MS }, (err, stdout, stderr) => {
      if (err?.killed === true) {
        reject(new Error(`bazhen ${args.join(" ")} ran past ${RUN_MS} ms:\n${stdout}${stderr}`));
        return;
      }
      resolve({ code: err === null ? 0 : Number(err.code ?? 1), stdout, stderr });
    });
  });
}

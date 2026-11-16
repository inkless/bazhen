// The `bazhen` CLI as a process, against a fake daemon on the socket it looks for. The suite
// holds the CLI's verbs, what it sends, what it prints and how it exits: it runs
// `target/release/bazhen`, which `pnpm test:medium` builds, unless `BAZHEN_CLI` names another
// binary. The api suites, which run the CLI against the real daemon, remain the end-to-end gate.

import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AddTaskNoteRequest,
  AssignTaskRequest,
  BroadcastMessageRequest,
  CreateTaskRequest,
  DelegateTaskRequest,
  DismissNoticeRequest,
  EnvRefreshRequest,
  ErrorResponse,
  EscalateRequest,
  FinishTaskRequest,
  RenameAgentRequest,
  SendMessageRequest,
  UnassignTaskRequest,
  WaitMessagesRequest,
} from "@bazhen/protocol";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const RUST_CLI = join(repo, "target/release/bazhen");
/** Past any call the CLI makes here, and short of the project's test timeout. */
export const RUN_MS = 20_000;

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

type Reply = { readonly status: number; readonly type: string; readonly body: string } | "hang";

/** A request schema, as far as checking a body the CLI sent needs one. */
interface Check {
  safeParse(value: unknown): { success: true } | { success: false; error: { message: string } };
}

const NO_BODY: Check = {
  safeParse: (value) =>
    value === undefined ? { success: true } : { success: false, error: { message: "no body" } },
};

/** Each command's request body, as the daemon checks it; a route not listed takes none. */
const REQUESTS: readonly (readonly [RegExp, Check])[] = [
  [/^POST \/v1\/tasks$/, CreateTaskRequest],
  [/^POST \/v1\/tasks\/delegate$/, DelegateTaskRequest],
  [/^POST \/v1\/tasks\/[^/]+\/assign$/, AssignTaskRequest],
  [/^POST \/v1\/tasks\/[^/]+\/unassign$/, UnassignTaskRequest],
  [/^POST \/v1\/tasks\/[^/]+\/finish$/, FinishTaskRequest],
  [/^POST \/v1\/tasks\/[^/]+\/notes$/, AddTaskNoteRequest],
  [/^POST \/v1\/tasks\/[^/]+\/messages$/, BroadcastMessageRequest],
  [/^POST \/v1\/agents\/[^/]+\/messages$/, SendMessageRequest],
  [/^POST \/v1\/agents\/[^/]+\/rename$/, RenameAgentRequest],
  [/^POST \/v1\/escalations$/, EscalateRequest],
  [/^POST \/v1\/messages\/wait$/, WaitMessagesRequest],
  [/^POST \/v1\/daemon\/env$/, EnvRefreshRequest],
  [/^POST \/v1\/notices\/[^/]+\/dismiss$/, DismissNoticeRequest],
];

const requestSchema = (route: string) =>
  REQUESTS.find(([pattern]) => pattern.test(route))?.[1] ?? NO_BODY;

const json = (status: number, value: unknown): Reply => ({
  status,
  type: "application/json",
  body: JSON.stringify(value),
});

/**
 * The daemon's socket, answering each route with a canned reply and recording every request. A
 * request whose body the daemon would refuse is answered 400, as the daemon answers it; a route it
 * wasn't given answers Hono's plain-text 404.
 */
export class FakeDaemon {
  readonly received: Received[] = [];
  readonly #routes = new Map<string, (r: Received) => Reply>();
  readonly #server: Server;
  readonly #hung: ServerResponse[] = [];

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
      req.on("end", () => daemon.#respond(req.method ?? "", req.url ?? "", req.headers, text, res));
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    return daemon;
  }

  #respond(
    method: string,
    path: string,
    headers: IncomingHttpHeaders,
    text: string,
    res: ServerResponse,
  ): void {
    const route = `${method} ${path}`;
    let body: unknown;
    try {
      body = text === "" ? undefined : JSON.parse(text);
    } catch {
      this.received.push({ method, path, headers, body: text });
      this.#send(res, json(400, { error: "invalid_request", message: "not JSON" }));
      return;
    }
    const received = { method, path, headers, body };
    this.received.push(received);
    const checked = requestSchema(route).safeParse(body);
    if (!checked.success) {
      this.#send(res, json(400, { error: "invalid_request", message: checked.error.message }));
      return;
    }
    const answer = this.#routes.get(route);
    this.#send(
      res,
      answer?.(received) ?? { status: 404, type: "text/plain", body: "404 Not Found" },
    );
  }

  #send(res: ServerResponse, reply: Reply): void {
    if (reply === "hang") {
      this.#hung.push(res);
      return;
    }
    res.writeHead(reply.status, { "content-type": reply.type });
    res.end(reply.body);
  }

  /** Answers `route` ("GET /v1/state") with `value`, checked against the reply's schema. */
  answer<T>(route: string, schema: Schema<T>, value: T): this {
    return this.answerWith(route, schema, () => value);
  }

  /** Answers `route` with what `make` makes of each request, checked against the schema. */
  answerWith<T>(route: string, schema: Schema<T>, make: (r: Received) => T): this {
    this.#routes.set(route, (r) => json(200, schema.parse(make(r))));
    return this;
  }

  /** Refuses `route` as the daemon refuses a command: a status, and an error the protocol names. */
  fail(route: string, status: number, error: ErrorResponse): this {
    this.#routes.set(route, () => json(status, ErrorResponse.parse(error)));
    return this;
  }

  /** Answers `route` with a body no schema checks, as a daemon this CLI can't read might. */
  raw(route: string, status: number, body: string): this {
    this.#routes.set(route, () => ({ status, type: "application/json", body }));
    return this;
  }

  /** Never answers `route`, as a wedged daemon doesn't. */
  hang(route: string): this {
    this.#routes.set(route, () => "hang");
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
    for (const res of this.#hung.splice(0)) res.destroy();
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
  /** A directory of the scene's own, holding the rest, removed with it. */
  readonly root: string;
  /** `BAZHEN_HOME`, under which the CLI looks for the daemon's socket. */
  readonly home: string;
  /** A directory to run the CLI in and keep files the CLI reads. */
  readonly dir: string;
  /** The socket the CLI finds from `home`. */
  readonly socket: string;
  readonly daemon: FakeDaemon;
  /** Runs `bazhen <args>` in `dir`, with `env` over the scene's own environment, and `input` on
   * its stdin. */
  readonly bazhen: (
    args: readonly string[],
    env?: Record<string, string>,
    input?: string,
  ) => Promise<Ran>;
  /** As `bazhen`, with only `env` and the scene's PATH: no BAZHEN_HOME. */
  readonly bare: (args: readonly string[], env: Record<string, string>) => Promise<Ran>;
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
  let daemon: FakeDaemon;
  try {
    daemon = await FakeDaemon.listen(socket);
  } catch (err) {
    rmSync(root, { recursive: true, force: true });
    throw err;
  }
  const path = { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: root };
  return {
    root,
    home,
    dir,
    socket,
    daemon,
    bazhen: (args, env = {}, input = "") =>
      run(args, { ...path, BAZHEN_HOME: home, ...env }, dir, input),
    bare: (args, env) => run(args, { ...path, ...env }, dir),
    cleanup: async () => {
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function run(
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
  input = "",
): Promise<Ran> {
  const binary = process.env["BAZHEN_CLI"] ?? "";
  const file = binary === "" ? RUST_CLI : binary;
  return new Promise((resolve, reject) => {
    const child = execFile(file, args, { env, cwd, timeout: RUN_MS }, (err, stdout, stderr) => {
      if (err?.killed === true) {
        reject(new Error(`bazhen ${args.join(" ")} ran past ${RUN_MS} ms:\n${stdout}${stderr}`));
        return;
      }
      resolve({ code: err === null ? 0 : Number(err.code ?? 1), stdout, stderr });
    });
    // A CLI that doesn't read its stdin may exit before this lands; that is no failure of its.
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  });
}

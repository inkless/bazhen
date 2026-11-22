// The `bazhen` CLI as a process, against a fake daemon on the socket it looks for. The suite
// holds the CLI's verbs, what it sends, what it prints and how it exits: it runs
// `target/release/bazhen`, which `moon run :test-medium` builds, unless `BAZHEN_CLI` names another
// binary, as falsify names the base's build. The api suites, which run the CLI against the real
// daemon, remain the end-to-end gate.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import {
  createServer,
  type IncomingHttpHeaders,
  type Server,
  type ServerResponse,
} from "node:http";
import { createServer as createSocketServer, type Socket } from "node:net";
import { dirname, join } from "node:path";
import type { Duplex } from "node:stream";
import { fileURLToPath } from "node:url";
import {
  AddTaskNoteRequest,
  AssignTaskRequest,
  BroadcastMessageRequest,
  CloseAgentRequest,
  CloseShellRequest,
  CreateTaskRequest,
  DelegateTaskRequest,
  DismissNoticeRequest,
  EnvRefreshRequest,
  ErrorResponse,
  EscalateRequest,
  EventEnvelopeFrame,
  CallerResponse,
  FinishTaskRequest,
  LaunchAgentRequest,
  OpenShellRequest,
  RelaunchAgentRequest,
  RenameAgentRequest,
  RespawnAgentRequest,
  SendMessageRequest,
  SignalAgentRequest,
  UnassignTaskRequest,
  WaitMessagesRequest,
  WaitRequest,
  encodeHolderReply,
  HOLDER_PROTOCOL_VERSION,
  holderRequestDecoder,
  type HolderHelloRequest,
} from "@bazhen/protocol";
import { WebSocketServer } from "ws";

const repo = fileURLToPath(new URL("../..", import.meta.url));
const RUST_CLI = join(repo, "target/release/bazhen");
/** The CLI under test: `BAZHEN_CLI` when set, else the checkout's release build. */
export const cliBinary = () => {
  const binary = process.env["BAZHEN_CLI"] ?? "";
  return binary === "" ? RUST_CLI : binary;
};
/**
 * A copy of the CLI under test in a checkout of its own under `root`, whose daemon start-up is
 * `startTs`, so `bazhen start` runs that instead of starting a daemon. Returns the copy's path.
 */
export function checkoutWith(root: string, startTs: string): string {
  const binary = join(root, "target", "release", "bazhen");
  const entry = join(root, "apps", "daemon", "src", "start.ts");
  mkdirSync(dirname(binary), { recursive: true });
  mkdirSync(dirname(entry), { recursive: true });
  copyFileSync(cliBinary(), binary);
  writeFileSync(entry, startTs);
  return binary;
}

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
  [/^POST \/v1\/agents$/, LaunchAgentRequest],
  [/^POST \/v1\/agents\/[^/]+\/close$/, CloseAgentRequest],
  [/^POST \/v1\/agents\/[^/]+\/respawn$/, RespawnAgentRequest],
  [/^POST \/v1\/agents\/[^/]+\/relaunch$/, RelaunchAgentRequest],
  [/^POST \/v1\/agents\/[^/]+\/signal$/, SignalAgentRequest],
  [/^POST \/v1\/shells$/, OpenShellRequest],
  [/^POST \/v1\/shells\/[^/]+\/close$/, CloseShellRequest],
  [/^POST \/v1\/escalations$/, EscalateRequest],
  [/^POST \/v1\/messages\/wait$/, WaitMessagesRequest],
  [/^POST \/v1\/waits$/, WaitRequest],
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
/** One `/v1/events` stream the CLI opened: what the fake daemon sends on it. */
export interface EventStream {
  /** Sends `frame`, checked against the schema. */
  readonly send: (frame: EventEnvelopeFrame) => void;
  /** Closes the stream, as the daemon does after a reset or when it stops. */
  readonly close: () => void;
}

/** RFC 6455's key suffix, from which a server's `Sec-WebSocket-Accept` is made. */
const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/** `text` as a server's WebSocket text frame, unmasked. */
function textFrame(text: string): Buffer {
  const data = Buffer.from(text, "utf8");
  if (data.length >= 65536) throw new Error("a frame this long needs the 64-bit length");
  const head =
    data.length < 126
      ? Buffer.from([0x81, data.length])
      : Buffer.from([0x81, 126, data.length >> 8, data.length & 0xff]);
  return Buffer.concat([head, data]);
}

export class FakeDaemon {
  readonly received: Received[] = [];
  readonly #routes = new Map<string, (r: Received) => Reply | Promise<Reply>>();
  readonly #server: Server;
  readonly #socket: string;
  readonly #hung: ServerResponse[] = [];
  readonly #sockets = new WebSocketServer({ noServer: true });
  /** Streams answered by hand, closed with the daemon. */
  readonly #held: Duplex[] = [];
  /** Answers an upgrade by hand, in place of the WebSocket server. */
  #byHand: ((conn: Duplex, key: string) => void) | undefined;
  /** The `/v1/events` streams the CLI opened, in order. */
  readonly opened: EventStream[] = [];
  #serve: readonly ((stream: EventStream) => void)[] | undefined;
  #refuse = { status: 404, type: "text/plain", body: "404 Not Found" };

  private constructor(server: Server, socket: string) {
    this.#server = server;
    this.#socket = socket;
  }

  static async listen(socket: string): Promise<FakeDaemon> {
    const server = createServer();
    const daemon = new FakeDaemon(server, socket);
    server.on("request", (req, res) => {
      let text = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => (text += chunk));
      req.on("end", () => daemon.#respond(req.method ?? "", req.url ?? "", req.headers, text, res));
    });
    server.on("upgrade", (req, conn: Duplex, head: Buffer) => {
      const path = req.url ?? "";
      daemon.received.push({ method: "GET", path, headers: req.headers, body: undefined });
      if (daemon.#byHand !== undefined) {
        daemon.#held.push(conn);
        daemon.#byHand(conn, String(req.headers["sec-websocket-key"]));
        return;
      }
      const serve = daemon.#serve;
      if (serve === undefined) {
        const reply = daemon.#refuse;
        conn.end(
          `HTTP/1.1 ${reply.status} Refused\r\ncontent-type: ${reply.type}\r\n` +
            `content-length: ${Buffer.byteLength(reply.body)}\r\nconnection: close\r\n\r\n${reply.body}`,
        );
        return;
      }
      if (!path.startsWith("/v1/events?")) {
        conn.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
        return;
      }
      daemon.#sockets.handleUpgrade(req, conn, head, (ws) => {
        const stream: EventStream = {
          send: (frame) => ws.send(JSON.stringify(EventEnvelopeFrame.parse(frame))),
          close: () => ws.close(),
        };
        serve[daemon.opened.length]?.(stream);
        daemon.opened.push(stream);
      });
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
    const reply =
      typeof answer === "function"
        ? answer(received)
        : { status: 404, type: "text/plain", body: "404 Not Found" };
    if (reply instanceof Promise)
      reply.then(
        (r) => this.#send(res, r),
        (cause: unknown) =>
          this.#send(res, json(500, { error: "internal", message: String(cause) })),
      );
    else this.#send(res, reply);
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

  /** Answers `route` with what `make` comes to, as a daemon holding a call answers late. */
  answerLater<T>(route: string, schema: Schema<T>, make: (r: Received) => Promise<T>): this {
    this.#routes.set(route, async (r) => json(200, schema.parse(await make(r))));
    return this;
  }

  /** Takes the CLI's calls to be agent `agentId`'s, or the human's as null, as `/v1/caller` says. */
  takes(agentId: string | null): this {
    return this.answer("GET /v1/caller", CallerResponse, { agentId });
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

  /** Serves `/v1/events`: the CLI's nth stream gets `serves[n]`; one past them is left open. */
  events(...serves: ((stream: EventStream) => void)[]): this {
    this.#serve = serves;
    return this;
  }

  /** Refuses every `/v1/events` stream, as the daemon refuses an upgrade. */
  refuseEvents(status: number, error: ErrorResponse): this {
    this.#serve = undefined;
    this.#refuse = {
      status,
      type: "application/json",
      body: JSON.stringify(ErrorResponse.parse(error)),
    };
    return this;
  }

  /** Never answers a `/v1/events` upgrade, as a wedged daemon doesn't. */
  hangEvents(): this {
    this.#byHand = () => undefined;
    return this;
  }

  /**
   * Answers the CLI's `/v1/events` streams with `texts` as frames in the same write as the 101,
   * then leaves them open; what the stream sends after goes as frames written by hand too.
   */
  eventsWithTheAnswer(...texts: string[]): this {
    this.#byHand = (conn, key) => {
      const accept = createHash("sha1").update(`${key}${WEBSOCKET_GUID}`).digest("base64");
      const answer =
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`;
      conn.write(Buffer.concat([Buffer.from(answer), ...texts.map(textFrame)]));
      this.opened.push({
        send: (frame) => conn.write(textFrame(JSON.stringify(EventEnvelopeFrame.parse(frame)))),
        close: () => conn.end(Buffer.from([0x88, 0])),
      });
    };
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

  /**
   * Stops answering, as a stopped daemon does: the socket goes before the connections drop, so a
   * client that sees one drop and looks for the daemon finds no socket, not one that is there and
   * answers nothing.
   */
  async close(): Promise<void> {
    if (this.#server.listening) rmSync(this.#socket, { force: true });
    for (const res of this.#hung.splice(0)) res.destroy();
    for (const conn of this.#held.splice(0)) conn.destroy();
    for (const ws of this.#sockets.clients) ws.terminate();
    this.#sockets.close();
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
  /** Starts `bazhen <args>` in `dir` and leaves it running, as `events follow` runs. */
  readonly start: (args: readonly string[]) => Running;
  /** As `bazhen`, with only `env` and the scene's PATH: no BAZHEN_HOME. */
  readonly bare: (args: readonly string[], env: Record<string, string>) => Promise<Ran>;
  readonly cleanup: () => Promise<void>;
}

/**
 * Holds the start-up lock beside `socket` as a daemon does, until the returned function lets go.
 * It needs `flock(1)`, which Linux has.
 */
export async function holdLock(socket: string): Promise<() => Promise<void>> {
  const held = spawn("flock", ["-x", `${socket}.lock`, "sh", "-c", "echo held; cat"], {
    stdio: ["pipe", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    held.once("error", reject);
    held.once("close", (code) => reject(new Error(`flock exited ${code} without the lock`)));
    held.stdout.once("data", () => {
      held.removeAllListeners("close");
      resolve();
    });
  });
  return () =>
    new Promise<void>((resolve) => {
      if (held.exitCode !== null) return resolve();
      held.once("close", () => resolve());
      held.stdin.end();
    });
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
    start: (args) => start(args, { ...path, BAZHEN_HOME: home }, dir),
    cleanup: async () => {
      await daemon.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A CLI left running: what it has printed so far, and how it ends. */
export interface Running {
  readonly child: ChildProcess;
  readonly stdout: () => string;
  readonly stderr: () => string;
  /** Resolves once stdout or stderr holds `text`; rejects if the CLI ends first. */
  readonly printed: (text: string) => Promise<void>;
  /** Stops reading the CLI's stdout, as `head` does once it has its lines. */
  readonly stopReading: () => void;
  readonly ended: Promise<Ran>;
}

function start(args: readonly string[], env: Record<string, string>, cwd: string): Running {
  const file = cliBinary();
  const child = spawn(file, args, { env, cwd, timeout: RUN_MS });
  let stdout = "";
  let stderr = "";
  const waiting: { text: string; resolve: () => void; reject: (e: Error) => void }[] = [];
  const check = () => {
    for (const w of waiting.splice(0)) {
      if (stdout.includes(w.text) || stderr.includes(w.text)) w.resolve();
      else waiting.push(w);
    }
  };
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    check();
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
    check();
  });
  child.stdout.on("error", () => {});
  const ended = new Promise<Ran>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      for (const w of waiting.splice(0)) {
        w.reject(new Error(`bazhen ended without printing ${w.text}:\n${stdout}${stderr}`));
      }
      if (signal !== null) {
        reject(new Error(`bazhen ${args.join(" ")} ended by ${signal}:\n${stdout}${stderr}`));
        return;
      }
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
  // Every wait on `ended` is a test's own; a CLI that outlived its test is no failure of that.
  ended.catch(() => {});
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    printed: (text) =>
      new Promise((resolve, reject) => {
        waiting.push({ text, resolve, reject });
        check();
      }),
    stopReading: () => child.stdout.destroy(),
    ended,
  };
}

function run(
  args: readonly string[],
  env: Record<string, string>,
  cwd: string,
  input = "",
): Promise<Ran> {
  const file = cliBinary();
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

/** A holder's socket as `bazhen terminals attach --direct` finds it: what it was asked, and its end. */
export interface FakeHolder {
  /** Each `hello` the holder was sent, in order. */
  readonly hellos: HolderHelloRequest[];
  readonly close: () => Promise<void>;
}

/**
 * A holder of `terminalId` listening at `path`, which answers `hello` as a holder speaking this
 * build's protocol does, granting the writer slot to whoever asks, and nothing else.
 */
export async function fakeHolder(path: string, terminalId: string): Promise<FakeHolder> {
  const hellos: HolderHelloRequest[] = [];
  const sockets = new Set<Socket>();
  const server = createSocketServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    const decoder = holderRequestDecoder();
    socket.on("data", (chunk: Uint8Array) => {
      for (const request of decoder.push(chunk).frames) {
        if (request.type !== "hello") continue;
        hellos.push(request.body);
        const body = {
          version: HOLDER_PROTOCOL_VERSION,
          protocol: [HOLDER_PROTOCOL_VERSION],
          terminalId,
          tags: {},
          generation: 0,
          holderPid: 4242,
          holderStart: 1_700_000_000,
          childPid: 4243,
          childStart: 1_700_000_000,
          exit: null,
          size: { cols: 80, rows: 24 },
          offset: 0,
          title: "",
          alternate: false,
          historyLines: 10_000,
          writer: request.body.writer === true,
        };
        socket.write(encodeHolderReply({ type: "hello", id: request.id, body }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, resolve);
  });
  return {
    hellos,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

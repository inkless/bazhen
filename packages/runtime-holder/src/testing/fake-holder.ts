import { createServer, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import {
  encodeHolderReply,
  HOLDER_PROTOCOL_VERSION,
  holderRequestDecoder,
  type HolderHelloReply,
  type HolderReply,
  type HolderRequest,
  type UnknownHolderRequest,
} from "@bazhen/protocol";

export type FakeRequest = HolderRequest | UnknownHolderRequest;

export function fakeHello(overrides: Partial<HolderHelloReply> = {}): HolderHelloReply {
  return {
    version: HOLDER_PROTOCOL_VERSION,
    protocol: [HOLDER_PROTOCOL_VERSION],
    terminalId: "fake",
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
    writer: false,
    ...overrides,
  };
}

export interface FakeHolderOptions {
  /**
   * Answers `hello` with `fakeHello` and these fields, `writer` granted when asked; `false`
   * leaves `hello` to the test, like every other request.
   */
  readonly hello?: Partial<HolderHelloReply> | false;
  /** Answers `close` instead of leaving it to the test. */
  readonly onClose?: (holder: FakeHolder, request: HolderRequest) => void;
}

/**
 * The holder's end of one connection, knowing nothing of what a holder does: the test reads the
 * requests in order and writes the answers and events.
 */
export class FakeHolder {
  /** Each chunk read, as the client wrote it. */
  readonly chunks: Uint8Array[] = [];
  private readonly stream: Duplex;
  private readonly queued: FakeRequest[] = [];
  private readonly waiting: ((request: FakeRequest) => void)[] = [];

  constructor(stream: Duplex, options: FakeHolderOptions = {}) {
    this.stream = stream;
    const decoder = holderRequestDecoder();
    stream.on("data", (chunk: Uint8Array) => {
      this.chunks.push(chunk);
      const { frames, malformed } = decoder.push(chunk);
      for (const request of frames) {
        if (request.type === "hello" && options.hello !== false) {
          const writer = request.body.writer ?? false;
          const body = fakeHello({ writer, ...options.hello });
          this.send({ type: "hello", id: request.id, body });
        } else if (request.type === "close" && options.onClose !== undefined) {
          options.onClose(this, request);
        } else {
          this.take(request);
        }
      }
      if (malformed !== null) this.hangUp();
    });
    stream.on("error", () => {});
  }

  private take(request: FakeRequest): void {
    const waiter = this.waiting.shift();
    if (waiter === undefined) this.queued.push(request);
    else waiter(request);
  }

  /** The next request the client sent, `hello` included when the test answers it. */
  request(): Promise<FakeRequest> {
    const request = this.queued.shift();
    if (request !== undefined) return Promise.resolve(request);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Writes the replies and events in one write. */
  send(...replies: HolderReply[]): void {
    this.sendRaw(Buffer.concat(replies.map(encodeHolderReply)));
  }

  sendRaw(bytes: Uint8Array): void {
    this.stream.write(bytes);
  }

  hangUp(): void {
    this.stream.end(() => this.stream.destroy());
  }
}

export interface FakeHolderServer {
  readonly path: string;
  /** The next connection's holder end, past its `hello` when the fake answers that. */
  connection(): Promise<FakeHolder>;
  close(): Promise<void>;
}

/**
 * What a fake holder does with `close`: what a real one does, answer `ok` then end every
 * connection and remove its socket (`exits`); answer `ok` and stay (`stays`); or leave it to
 * the test, like a holder that ignores it (`ignores`).
 */
export type FakeClose = "exits" | "stays" | "ignores";

/** A fake holder on a Unix socket at `path`. */
export async function listenFakeHolder(
  path: string,
  options: Omit<FakeHolderOptions, "onClose"> & { readonly close?: FakeClose } = {},
): Promise<FakeHolderServer> {
  const sockets = new Set<Socket>();
  const connected: FakeHolder[] = [];
  const waiting: ((holder: FakeHolder) => void)[] = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    const holder = new FakeHolder(
      socket,
      options.close === "ignores" ? options : { ...options, onClose: answerClose },
    );
    const waiter = waiting.shift();
    if (waiter === undefined) connected.push(holder);
    else waiter(holder);
  });
  const close = () =>
    new Promise<void>((resolve) => {
      for (const socket of sockets) socket.end();
      server.close(() => resolve());
    });
  const answerClose = (holder: FakeHolder, request: HolderRequest) => {
    holder.send({ type: "ok", id: request.id, body: { request: "close" } });
    if (options.close !== "stays") void close();
  };
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(path, () => resolve());
  });
  return {
    path,
    connection: () => {
      const holder = connected.shift();
      if (holder !== undefined) return Promise.resolve(holder);
      return new Promise((resolve) => waiting.push(resolve));
    },
    close,
  };
}

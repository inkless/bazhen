import { connect } from "node:net";
import type { Duplex } from "node:stream";
import {
  encodeHolderRequest,
  HOLDER_ERROR_CODES,
  HOLDER_MAX_REQUEST_BYTES,
  HOLDER_PROTOCOL_VERSION,
  holderReplyDecoder,
  type HolderError,
  type HolderHelloReply,
  type HolderProcessSpec,
  type HolderReply,
  type HolderRequest,
  type HolderSignal,
  type HolderSize,
  type HolderSubscribeRequest,
  type HolderTags,
  type HolderTheme,
  type UnknownHolderReply,
} from "@bazhen/protocol";
import { nextRequestId } from "./request-ids.ts";

type ReplyOf<K extends HolderReply["type"]> = Extract<HolderReply, { type: K }>;

export type HolderSnapshot = ReplyOf<"snapshot">;

/**
 * What the holder sends unasked, in the order it sent it. `snapshot` is an `attach`'s, in its
 * place ahead of the output that follows it; `refused` is an `input` the holder turned down.
 */
export type HolderEvent =
  | ReplyOf<"data" | "gap" | "resized" | "title" | "alternate" | "exited" | "respawned">
  | HolderSnapshot
  | { readonly type: "refused"; readonly id: number; readonly error: HolderRequestError };

/** Why a connection ended: hung up by either side, a frame that broke the protocol, or I/O. */
export type HolderEnd =
  | { readonly reason: "eof" }
  | { readonly reason: "malformed"; readonly message: string }
  | { readonly reason: "error"; readonly error: Error };

export type HolderErrorCode = (typeof HOLDER_ERROR_CODES)[number];

const isKnownCode = (code: string): code is HolderErrorCode =>
  (HOLDER_ERROR_CODES as readonly string[]).includes(code);

/** The holder answered a request with `error`. A code newer than this build reads as `failed`. */
export class HolderRequestError extends Error {
  readonly code: HolderErrorCode;
  readonly rawCode: string;
  readonly request: string;
  /** The holder's versions, sent with `no-shared-version`. */
  readonly protocol: readonly string[] | undefined;

  constructor(body: HolderError) {
    super(`holder refused ${body.request}: ${body.code}: ${body.message}`);
    this.name = "HolderRequestError";
    this.code = isKnownCode(body.code) ? body.code : "failed";
    this.rawCode = body.code;
    this.request = body.request;
    this.protocol = body.protocol;
  }
}

function describe(end: HolderEnd): string {
  if (end.reason === "eof") return "hung up";
  if (end.reason === "malformed") return `broke the protocol: ${end.message}`;
  return end.error.message;
}

export class HolderDisconnected extends Error {
  readonly end: HolderEnd;

  constructor(end: HolderEnd) {
    super(`holder connection ended: ${describe(end)}`, {
      cause: end.reason === "error" ? end.error : undefined,
    });
    this.name = "HolderDisconnected";
    this.end = end;
  }
}

export interface HolderClientOptions {
  /**
   * Called for every event, synchronously and in the order the holder sent them. One that throws
   * while the connection is open ends it with that error.
   */
  readonly onEvent: (event: HolderEvent) => void;
  /** Ask for the slot whose `input` the holder takes; `hello.writer` says whether it was given. */
  readonly writer?: boolean;
  /** Abandons the handshake: a holder that never answers `hello` can't hold the caller. */
  readonly signal?: AbortSignal;
  /** How long a hang-up waits for the holder to take what is unsent; `HOLDER_HANG_UP_MS` if unset. */
  readonly hangUpMs?: number;
}

export interface RequestOptions {
  /**
   * Abandons the request; an answer that arrives later is dropped. Aborting a `subscribe` once
   * sent ends the connection, as the holder may already be sending its output; so does any
   * failure of an `attach`.
   */
  readonly signal?: AbortSignal;
}

type AnswerName = "hello" | "snapshot" | "stats" | "foreground" | "ok";
const ANSWERS: ReadonlySet<string> = new Set(["hello", "snapshot", "stats", "foreground", "ok"]);
const isAnswer = (frame: HolderReply): frame is ReplyOf<AnswerName> => ANSWERS.has(frame.type);

const isReplyOf = <K extends AnswerName>(reply: HolderReply, type: K): reply is ReplyOf<K> =>
  reply.type === type;

interface Pending {
  readonly request: string;
  /** Settles the request with its answer; settles nothing for one of another kind or out of turn. */
  readonly accept: (reply: ReplyOf<AnswerName>) => "taken" | "wrong" | "early";
  readonly reject: (error: unknown) => void;
  /** Whether the holder refusing it ends the connection. */
  readonly endsOnRefusal: boolean;
}

interface Sending<K extends AnswerName> {
  /** Collects the frame here instead of writing it, for the caller to write with others. */
  readonly batch?: Uint8Array[];
  /** Called with the answer as it is read, in order with the events around it. */
  readonly onAnswer?: (reply: ReplyOf<K>) => void;
  /**
   * What, once the request is sent, ends the connection: its abort (`abort`), or its abort or
   * refusal (`failure`). For requests the holder acts on whatever becomes of their answer, after
   * which output could run without its snapshot.
   */
  readonly endsOn?: "abort" | "failure";
  /** False while an answer would come out of turn, which breaks the protocol. */
  readonly inTurn?: () => boolean;
}

const asError = (value: unknown) => (value instanceof Error ? value : new Error(String(value)));

/** What one `input` frame carries: the cap less the type byte and the request id. */
const INPUT_CHUNK = HOLDER_MAX_REQUEST_BYTES - 1 - 4;
/** What each `input` frame adds to its bytes: the length, the type byte and the request id. */
const INPUT_OVERHEAD = 4 + 1 + 4;

/**
 * The most a connection holds written but not yet taken by the holder. A write that would go past
 * it ends the connection rather than queue it, so a holder that stopped reading can't grow this
 * process without bound. A caller sending more than one holder keeps up with checks `room`, or
 * awaits `drained()`, first.
 */
export const HOLDER_MAX_UNSENT_BYTES = 8 * HOLDER_MAX_REQUEST_BYTES;

/** How long a hang-up waits for the holder to take what is still unsent. */
export const HOLDER_HANG_UP_MS = 5_000;

/** One connection's requests, answers and events. `HolderClient` is its face after `hello`. */
class Connection {
  readonly ended: Promise<HolderEnd>;
  private readonly stream: Duplex;
  private readonly onEvent: (event: HolderEvent) => void;
  private readonly decoder = holderReplyDecoder();
  private readonly pending = new Map<number, Pending>();
  private lastId = 0;
  private end: HolderEnd | null = null;
  private settleEnded: (end: HolderEnd) => void = () => {};
  private readonly hangUpMs: number;
  /** Writes the stream hasn't yet passed on, and who waits for there to be none. */
  private writing = 0;
  private readonly drainWaiters = new Set<() => void>();

  constructor(stream: Duplex, onEvent: (event: HolderEvent) => void, hangUpMs: number) {
    this.stream = stream;
    this.onEvent = onEvent;
    this.hangUpMs = hangUpMs;
    this.ended = new Promise((resolve) => {
      this.settleEnded = resolve;
    });
    stream.on("data", (chunk: Uint8Array) => this.read(chunk));
    // The holder hung up: end this side too, whether or not the stream allows half-open.
    stream.on("end", () => this.fail({ reason: "eof" }));
    stream.on("close", () => this.finish({ reason: "eof" }));
    stream.on("error", (error) => this.finish({ reason: "error", error }));
  }

  get open(): boolean {
    return this.end === null;
  }

  private takeId(): number {
    this.lastId = nextRequestId(this.lastId, (id) => this.pending.has(id));
    return this.lastId;
  }

  private requireOpen(): void {
    if (this.end !== null) throw new HolderDisconnected(this.end);
  }

  /** Sends a request, answered by a reply of type `expects` or by `error`. */
  async ask<K extends AnswerName>(
    build: (id: number) => HolderRequest,
    expects: K,
    options: RequestOptions = {},
    sending: Sending<K> = {},
  ): Promise<ReplyOf<K>> {
    this.requireOpen();
    const { signal } = options;
    signal?.throwIfAborted();
    const request = build(this.takeId());
    const frame = encodeHolderRequest(request);
    const answer = new Promise<ReplyOf<K>>((resolve, reject) => {
      const forget = () => {
        this.pending.delete(request.id);
        reject(signal?.reason);
        if (sending.endsOn) this.fail({ reason: "error", error: asError(signal?.reason) });
      };
      signal?.addEventListener("abort", forget, { once: true });
      const stop = () => signal?.removeEventListener("abort", forget);
      this.pending.set(request.id, {
        request: request.type,
        accept: (reply) => {
          if (!isReplyOf(reply, expects)) return "wrong";
          if (sending.inTurn?.() === false) return "early";
          stop();
          sending.onAnswer?.(reply);
          resolve(reply);
          return "taken";
        },
        reject: (error) => {
          stop();
          reject(error);
        },
        endsOnRefusal: sending.endsOn === "failure",
      });
    });
    if (sending.batch) sending.batch.push(frame);
    else this.write([frame]);
    return answer;
  }

  /** Writes frames in one write; nothing once the connection has ended, as its requests have. */
  write(frames: readonly Uint8Array[]): void {
    if (frames.length === 0 || this.end !== null) return;
    if (!this.fits(frames.reduce((size, frame) => size + frame.length, 0))) return;
    this.push(frames.length === 1 ? frames[0]! : Buffer.concat(frames));
  }

  private push(bytes: Uint8Array): void {
    this.writing += 1;
    // A write's callback runs once the stream has passed it on, or with an error once destroyed.
    this.stream.write(bytes, () => {
      this.writing -= 1;
      if (this.writing === 0) this.settleDrained();
    });
  }

  private settleDrained(): void {
    const waiting = [...this.drainWaiters];
    this.drainWaiters.clear();
    for (const done of waiting) done();
  }

  /** What may still be written before the cap on unsent bytes; none once the connection ends. */
  get room(): number {
    if (this.end !== null) return 0;
    return Math.max(0, HOLDER_MAX_UNSENT_BYTES - this.stream.writableLength);
  }

  /**
   * Resolves once the stream has passed on everything written, or the connection has ended;
   * rejects on `signal`'s abort. Each waiter is dropped as it settles, so calls don't add up.
   */
  drained(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted === true) return Promise.reject(signal.reason);
    if (this.end !== null || this.writing === 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.drainWaiters.delete(done);
        reject(signal?.reason);
      };
      const done = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      this.drainWaiters.add(done);
      signal?.addEventListener("abort", abort, { once: true });
    });
  }

  /**
   * Whether `size` more bytes stay within what may be unsent. If not, the connection ends,
   * rejecting what waits.
   */
  private fits(size: number): boolean {
    const unsent = this.stream.writableLength;
    if (unsent + size <= HOLDER_MAX_UNSENT_BYTES) return true;
    const error = new Error(
      `over the unsent cap of ${HOLDER_MAX_UNSENT_BYTES} bytes: ${unsent} unsent and ${size} more`,
    );
    this.fail({ reason: "error", error });
    return false;
  }

  emit(event: HolderEvent): void {
    this.onEvent(event);
  }

  input(bytes: Uint8Array): number[] {
    this.requireOpen();
    const size = bytes.length + Math.ceil(bytes.length / INPUT_CHUNK) * INPUT_OVERHEAD;
    if (size > HOLDER_MAX_UNSENT_BYTES) {
      throw new RangeError(
        `input of ${bytes.length} bytes is over the ${HOLDER_MAX_UNSENT_BYTES} a holder ` +
          "connection holds unsent; send it in parts",
      );
    }
    if (bytes.length === 0) return [];
    if (!this.fits(size)) this.requireOpen();
    // Frame by frame, each written as it is made, rather than copied into one buffer.
    const ids: number[] = [];
    for (let at = 0; at < bytes.length; at += INPUT_CHUNK) {
      const id = this.takeId();
      ids.push(id);
      this.push(
        encodeHolderRequest({ type: "input", id, bytes: bytes.subarray(at, at + INPUT_CHUNK) }),
      );
    }
    return ids;
  }

  hangUp(): void {
    if (this.end !== null) return;
    this.finish({ reason: "eof" });
    // A holder that isn't reading would leave the end unflushed, and the socket open, for good.
    const stop = setTimeout(() => this.stream.destroy(), this.hangUpMs).unref();
    this.stream.end(() => {
      clearTimeout(stop);
      this.stream.destroy();
    });
  }

  private read(chunk: Uint8Array): void {
    if (this.end !== null) return;
    const { frames, malformed } = this.decoder.push(chunk);
    try {
      for (const frame of frames) {
        this.dispatch(frame);
        if (this.end !== null) return;
      }
    } catch (thrown) {
      // From `onEvent`: the frames after it are lost, so the connection can't go on in step.
      this.fail({ reason: "error", error: asError(thrown) });
      return;
    }
    if (malformed !== null) this.breakProtocol(malformed);
  }

  private dispatch(frame: HolderReply | UnknownHolderReply): void {
    if (frame.type === "unknown") {
      // This build sends only requests it knows, whose answers it knows too.
      if (frame.id !== undefined && this.pending.has(frame.id)) {
        const request = this.pending.get(frame.id)?.request;
        this.breakProtocol(`reply 0x${frame.code.toString(16)} answered ${request} ${frame.id}`);
      }
      return;
    }
    if (frame.type === "error") {
      this.answerError(frame);
      return;
    }
    if (!isAnswer(frame)) {
      this.onEvent(frame);
      return;
    }
    const pending = this.pending.get(frame.id);
    if (pending === undefined) return;
    const taken = pending.accept(frame);
    if (taken !== "taken") {
      const answered = `${frame.type} answered ${pending.request} request ${frame.id}`;
      this.breakProtocol(taken === "early" ? `${answered} out of turn` : answered);
      return;
    }
    this.pending.delete(frame.id);
  }

  private answerError(frame: ReplyOf<"error">): void {
    const error = new HolderRequestError(frame.body);
    const pending = this.pending.get(frame.id);
    if (pending === undefined) {
      // An `error` answering an aborted request is dropped, as any late answer is.
      if (frame.body.request === "input") this.onEvent({ type: "refused", id: frame.id, error });
      return;
    }
    this.pending.delete(frame.id);
    pending.reject(error);
    // At once, so that no frame after this one in the chunk reaches `onEvent`.
    if (pending.endsOnRefusal) this.fail({ reason: "error", error });
  }

  private breakProtocol(message: string): void {
    this.fail({ reason: "malformed", message });
  }

  private fail(end: HolderEnd): void {
    this.finish(end);
    this.stream.destroy();
  }

  private finish(end: HolderEnd): void {
    if (this.end !== null) return;
    this.end = end;
    const error = new HolderDisconnected(end);
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const pending of waiting) pending.reject(error);
    this.settleEnded(end);
    this.settleDrained();
  }
}

/** A connection to one holder, past `hello`. */
export class HolderClient {
  /** The holder's answer to `hello`. */
  readonly hello: HolderHelloReply;
  readonly ended: Promise<HolderEnd>;
  private readonly connection: Connection;

  private constructor(connection: Connection, hello: HolderHelloReply) {
    this.connection = connection;
    this.hello = hello;
    this.ended = connection.ended;
  }

  /**
   * Says `hello` on `stream` and resolves once the holder answers; nothing else is sent before.
   * A holder that shares no major with this build rejects it with `no-shared-version`.
   */
  static async open(stream: Duplex, options: HolderClientOptions): Promise<HolderClient> {
    const connection = new Connection(
      stream,
      options.onEvent,
      options.hangUpMs ?? HOLDER_HANG_UP_MS,
    );
    const hello = { protocol: [HOLDER_PROTOCOL_VERSION], writer: options.writer ?? false };
    try {
      const reply = await connection.ask(
        (id) => ({ type: "hello", id, body: hello }),
        "hello",
        options.signal ? { signal: options.signal } : {},
      );
      return new HolderClient(connection, reply.body);
    } catch (error) {
      stream.destroy();
      throw error;
    }
  }

  get open(): boolean {
    return this.connection.open;
  }

  /**
   * How many bytes may be written now before the cap on unsent bytes ends the connection: input
   * takes its length plus 9 bytes for each frame of up to 1 MiB. A holder reading slowly lowers
   * it for a while; it is 0 once the connection has ended.
   */
  get room(): number {
    return this.connection.room;
  }

  /**
   * Resolves once everything written has left this process, or the connection has ended. On a
   * socket that means the kernel holds the bytes, not that the holder has read them. A caller
   * with more to send than `room` awaits it first, rather than overrun a holder that is reading
   * slowly; `signal` bounds the wait on one that has stopped.
   */
  drained(options: RequestOptions = {}): Promise<void> {
    return this.connection.drained(options.signal);
  }

  /** The terminal as of the holder's offset, resolved here rather than sent to `onEvent`. */
  snapshot(options?: RequestOptions): Promise<HolderSnapshot> {
    return this.connection.ask((id) => ({ type: "snapshot", id }), "snapshot", options);
  }

  /**
   * A snapshot and a subscription in one write, which the holder serves from one point, so the
   * output that follows starts exactly where the snapshot ends. The snapshot goes to `onEvent`
   * ahead of that output; this resolves once the subscription is taken. If either half fails,
   * the connection ends, rather than going on with output that may have no snapshot.
   */
  async attach(options?: RequestOptions): Promise<void> {
    const batch: Uint8Array[] = [];
    let snapshotIn = false;
    const onAnswer = (snapshot: HolderSnapshot) => {
      snapshotIn = true;
      this.connection.emit(snapshot);
    };
    const answers = [
      this.connection.ask((id) => ({ type: "snapshot", id }), "snapshot", options, {
        batch,
        onAnswer,
        endsOn: "failure",
      }),
      // The holder answers in the order it read the two; output before the snapshot is unplaceable.
      this.connection.ask((id) => ({ type: "subscribe", id, body: {} }), "ok", options, {
        batch,
        endsOn: "failure",
        inTurn: () => snapshotIn,
      }),
    ];
    this.connection.write(batch);
    await Promise.all(answers);
  }

  /** Moves the connection's one subscription, an attach's included, to output from `from`. */
  async subscribe(from?: HolderSubscribeRequest["from"], options?: RequestOptions): Promise<void> {
    const body = from === undefined ? {} : { from };
    await this.connection.ask((id) => ({ type: "subscribe", id, body }), "ok", options, {
      endsOn: "abort",
    });
  }

  /**
   * Sends input, cut into frames under the cap, and returns their ids. The holder answers input
   * only to refuse it, as a `refused` event carrying the id. Input over `HOLDER_MAX_UNSENT_BYTES`
   * in one call throws a `RangeError`, sending none of it; input past it with what is still
   * unsent ends the connection, so a caller sending more than `room` awaits `drained()` first.
   */
  input(bytes: Uint8Array): number[] {
    return this.connection.input(bytes);
  }

  async resize(size: HolderSize, options?: RequestOptions): Promise<void> {
    await this.connection.ask((id) => ({ type: "resize", id, body: size }), "ok", options);
  }

  async signal(signal: HolderSignal, options?: RequestOptions): Promise<void> {
    await this.connection.ask((id) => ({ type: "signal", id, body: { signal } }), "ok", options);
  }

  async respawn(spec: HolderProcessSpec, options?: RequestOptions): Promise<void> {
    await this.connection.ask((id) => ({ type: "respawn", id, body: spec }), "ok", options);
  }

  async setTags(tags: HolderTags, options?: RequestOptions): Promise<void> {
    await this.connection.ask((id) => ({ type: "set-tags", id, body: { tags } }), "ok", options);
  }

  async setTheme(theme: HolderTheme | null, options?: RequestOptions): Promise<void> {
    await this.connection.ask((id) => ({ type: "set-theme", id, body: { theme } }), "ok", options);
  }

  async stats(options?: RequestOptions): Promise<ReplyOf<"stats">["body"]> {
    return (await this.connection.ask((id) => ({ type: "stats", id }), "stats", options)).body;
  }

  async foreground(options?: RequestOptions): Promise<ReplyOf<"foreground">["body"]> {
    const reply = await this.connection.ask(
      (id) => ({ type: "foreground", id }),
      "foreground",
      options,
    );
    return reply.body;
  }

  /**
   * Closes the terminal: once the holder says `ok`, it ends the child and exits. This resolves on
   * that `ok`, before the holder hangs up; await `ended` to know the connection is gone.
   */
  async close(options?: RequestOptions): Promise<void> {
    await this.connection.ask((id) => ({ type: "close", id }), "ok", options);
  }

  /**
   * Hangs up this connection, leaving the holder running. What is still unsent gets the
   * `hangUpMs` it was opened with to reach the holder before the stream is destroyed.
   */
  end(): void {
    this.connection.hangUp();
  }
}

/** Connects to a holder's socket and says `hello`. A socket nothing listens on rejects at once. */
export function connectHolder(path: string, options: HolderClientOptions): Promise<HolderClient> {
  return new Promise((resolve, reject) => {
    const socket = connect(path);
    const refused = (error: Error) => reject(new HolderDisconnected({ reason: "error", error }));
    socket.once("error", refused);
    socket.once("connect", () => {
      socket.off("error", refused);
      HolderClient.open(socket, options).then(resolve, reject);
    });
  });
}

// A holder terminal's streams. Each stream reads on a connection of its own, subscribed from its
// snapshot. What streams send, and the snapshots they take later, go through one control
// connection per terminal, unsubscribed and holding the writer slot:
//
// - a holder has one writer slot, which every stream of the terminal shares;
// - a snapshot sent on a subscribed connection moves its subscription to the snapshot's offset,
//   so the output between is never sent there, and other views reading it would miss it.

import type {
  ProgramExit,
  Size,
  Snapshot,
  SnapshotAttached,
  SnapshotStream,
  StreamEnd,
  StreamFailure,
} from "@bazhen/core";
import { HOLDER_MAX_REQUEST_BYTES } from "@bazhen/protocol";
import { HOLDER_MAX_UNSENT_BYTES, type HolderClient, type HolderEvent } from "./client.ts";

/** Opens a connection to the terminal's holder, sending its events to `onEvent`. */
export type OpenHolder = (
  writer: boolean,
  onEvent: (event: HolderEvent) => void,
) => Promise<HolderClient>;

/** What one write of input may hold, so it fits a connection's unsent cap with room to spare. */
const INPUT_PART = HOLDER_MAX_REQUEST_BYTES;
/** What input frames add to their bytes, at most, for one part. */
const PART_OVERHEAD = 64;
/** How long a holder that has stopped reading gets to take input, before its connection ends. */
export const DRAIN_MS = 10_000;
/** How long to wait before asking again for a writer slot another connection holds. */
export const WRITER_RETRY_MS: readonly number[] = [50, 200, 800];

/** Where a stream is: the generation and offset of the next byte it will deliver. */
interface Position {
  readonly generation: number;
  readonly offset: number;
}

const reached = (at: Position, target: Position) =>
  at.generation > target.generation ||
  (at.generation === target.generation && at.offset >= target.offset);

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms).unref());

/** What the control connection tells each stream using it. */
interface User {
  failed(failure: StreamFailure): void;
  /** `what` worked again, after any failure of it. */
  succeeded(what: string): void;
}

type Op =
  | { readonly kind: "input"; readonly bytes: Uint8Array }
  | {
      readonly kind: "resize";
      readonly size: Size;
      readonly resolve: () => void;
      readonly reject: (error: unknown) => void;
    };

export interface ControlOptions {
  readonly open: OpenHolder;
  /** The holder every connection must reach: another at the terminal's socket is refused. */
  readonly holder: { readonly pid: number; readonly start: number };
  /** Settles once the control connection before this one has closed, freeing the writer slot. */
  readonly after?: Promise<void> | undefined;
  /** Called once no stream uses it, with what settles once its connection has closed. */
  readonly onIdle: (closed: Promise<void>) => void;
  readonly drainMs?: number;
  readonly writerRetryMs?: readonly number[];
}

/**
 * One terminal's control connection, shared by its open streams. Opened on first use, and again
 * after it is lost, once the old one's socket has closed, so the holder has freed its writer slot.
 * Input and resizes go out in the order the streams gave them.
 */
export class Control {
  private readonly opts: ControlOptions;
  private client: HolderClient | null = null;
  private opening: Promise<HolderClient> | null = null;
  private readonly ops: Op[] = [];
  private queued = 0;
  private sending = false;
  private readonly users = new Set<User>();
  /** The last failure, until what failed works again: a stream that comes later hears of it. */
  private failure: StreamFailure | null = null;

  constructor(opts: ControlOptions) {
    this.opts = opts;
  }

  /** Whether it reaches `holder`, as a ref names it. */
  serves(holder: ControlOptions["holder"]): boolean {
    return holder.pid === this.opts.holder.pid && holder.start === this.opts.holder.start;
  }

  /** A stream starts using it: call what this returns once it closes. */
  acquire(user: User): () => void {
    this.users.add(user);
    if (this.failure !== null) user.failed(this.failure);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users.delete(user);
      if (this.users.size === 0) this.opts.onIdle(this.end());
    };
  }

  private fail(what: string, cause: unknown): void {
    const failure = { what, cause };
    this.failure = failure;
    for (const user of this.users) user.failed(failure);
  }

  private succeed(what: string): void {
    if (this.failure?.what === what) this.failure = null;
    for (const user of this.users) user.succeeded(what);
  }

  private connection(): Promise<HolderClient> {
    if (this.client?.open === true) return Promise.resolve(this.client);
    this.opening ??= this.connect().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  private async connect(): Promise<HolderClient> {
    await this.opts.after;
    const old = this.client;
    this.client = null;
    if (old !== null) {
      old.end();
      await old.closed;
    }
    const retries = this.opts.writerRetryMs ?? WRITER_RETRY_MS;
    for (let attempt = 0; ; attempt += 1) {
      const client = await this.opts.open(true, (event) => {
        if (event.type === "refused") this.fail("input", event.error);
      });
      const refusal = this.refusal(client);
      if (refusal === null) {
        this.client = client;
        return client;
      }
      client.end();
      await client.closed;
      const wait = retries[attempt];
      if (refusal.retry !== true || wait === undefined) throw refusal.error;
      await delay(wait);
    }
  }

  /** Why `client` can't be the control connection, and whether asking again may help. */
  private refusal(client: HolderClient): { error: Error; retry?: boolean } | null {
    if (this.users.size === 0) return { error: new Error("no stream uses the terminal any more") };
    const { holderPid, holderStart, writer } = client.hello;
    if (!this.serves({ pid: holderPid, start: holderStart })) {
      return { error: new Error("another holder serves the terminal's socket now") };
    }
    if (!writer) {
      return {
        error: new Error("another connection holds the terminal's writer slot"),
        retry: true,
      };
    }
    return null;
  }

  /** Queues `bytes` as input; past what a connection holds unsent, refuses them and says so. */
  write(bytes: Uint8Array): void {
    if (this.queued + bytes.length > HOLDER_MAX_UNSENT_BYTES) {
      const why = `over the ${HOLDER_MAX_UNSENT_BYTES} bytes of input a terminal holds unsent`;
      this.fail("input", new RangeError(`refused ${bytes.length} bytes of input: ${why}`));
      return;
    }
    for (let at = 0; at < bytes.length; at += INPUT_PART) {
      this.ops.push({ kind: "input", bytes: bytes.subarray(at, at + INPUT_PART) });
    }
    this.queued += bytes.length;
    void this.send();
  }

  /** Resizes the terminal once what was written before has gone out. */
  resize(size: Size): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ops.push({ kind: "resize", size, resolve, reject });
      void this.send();
    });
  }

  /** Sends what is queued, in order, waiting for room rather than overrunning the connection. */
  private async send(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let op = this.ops[0]; op !== undefined; op = this.ops[0]) {
        const client = await this.connection();
        if (op.kind === "resize") {
          this.ops.shift();
          await client.resize(op.size).then(
            () => {
              op.resolve();
              this.succeed("resize");
            },
            (error: unknown) => op.reject(error),
          );
          continue;
        }
        if (client.room < op.bytes.length + PART_OVERHEAD) {
          const signal = AbortSignal.timeout(this.opts.drainMs ?? DRAIN_MS);
          await client.drained({ signal }).catch((cause: unknown) => {
            client.end();
            throw new Error("the holder stopped taking input", { cause });
          });
        }
        // Its streams closed meanwhile, and took what was queued with them.
        if (this.ops[0] !== op) continue;
        client.input(op.bytes);
        this.ops.shift();
        this.queued -= op.bytes.length;
        this.succeed("input");
      }
    } catch (error) {
      this.drop(error);
      this.fail("input", error);
    } finally {
      this.sending = false;
    }
  }

  /** Forgets what is queued: input is dropped, and a resize waiting is rejected with `error`. */
  private drop(error: unknown): void {
    for (const op of this.ops.splice(0)) if (op.kind === "resize") op.reject(error);
    this.queued = 0;
  }

  async snapshot(): Promise<Snapshot> {
    const { bytes, offset, generation } = await (await this.connection()).snapshot();
    return { vt: bytes, offset, generation };
  }

  /**
   * Hangs up, leaving the holder running, and drops what is queued. Returns what settles once its
   * connection, or one still opening, has closed.
   */
  end(): Promise<void> {
    this.drop(new Error("the terminal's streams have all closed"));
    this.client?.end();
    const opening = this.opening;
    const client = this.client;
    return (async () => {
      const opened = await opening?.catch(() => null);
      opened?.end();
      await Promise.all([client?.closed, opened?.closed]);
    })();
  }
}

interface Held {
  readonly at: Position;
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
}

/**
 * A stream on its own reader connection. Events are held until the consumer has had a turn to
 * register its callbacks, then delivered in the order the holder sent them.
 */
export class HolderStream implements SnapshotStream {
  size: Size;
  private reader: HolderClient | null = null;
  private readonly control: Control;
  private readonly release: () => void;
  private at: Position = { generation: 0, offset: 0 };
  /** The attach's snapshot, once read: the events before it describe the state it captured. */
  private attached: Snapshot | null = null;
  private flowing = false;
  private readonly early: HolderEvent[] = [];
  private ended: StreamEnd | null = null;
  private readonly held = new Set<Held>();
  private readonly dataListeners: ((bytes: Uint8Array) => void)[] = [];
  private readonly closeListeners: ((why: StreamEnd) => void)[] = [];
  private readonly respawnListeners: ((generation: number) => void)[] = [];
  private readonly exitListeners: ((exit: ProgramExit) => void)[] = [];
  private exit: ProgramExit | null = null;
  private readonly failureListeners: ((failure: StreamFailure) => void)[] = [];
  /** What failed last and is still failing, reported once until it succeeds again. */
  private failing: StreamFailure | null = null;

  constructor(control: Control, size: Size) {
    this.control = control;
    this.size = size;
    this.release = control.acquire({
      failed: (failure) => this.report(failure),
      succeeded: (what) => this.succeeded(what),
    });
  }

  /** Attaches on `reader`, whose events must come to `event`: its snapshot, then its output. */
  async attach(reader: HolderClient): Promise<SnapshotAttached> {
    this.reader = reader;
    void reader.ended.then(() => this.end("ended"));
    try {
      await reader.attach();
    } catch (error) {
      this.close();
      throw error;
    }
    const { attached } = this;
    if (attached === null) throw new Error("the holder subscribed the stream without its snapshot");
    // The consumer registers its callbacks in the turn `attach` resolves in; output read meanwhile
    // waits for it.
    setImmediate(() => this.flow());
    return {
      kind: "snapshot",
      ...attached,
      stream: this,
      historyLines: reader.hello.historyLines,
    };
  }

  /** Where the reader's events come in, in the order the holder sent them. */
  event(event: HolderEvent): void {
    if (this.attached === null) {
      this.beforeSnapshot(event);
      return;
    }
    if (this.flowing) this.handle(event);
    else this.early.push(event);
  }

  /**
   * An event read before the attach's snapshot, which already shows what it did: a resize only
   * sets the size the snapshot is told with, and a respawn is in it already.
   */
  private beforeSnapshot(event: HolderEvent): void {
    if (event.type === "snapshot") {
      this.attached = { vt: event.bytes, offset: event.offset, generation: event.generation };
      this.at = { generation: event.generation, offset: event.offset };
    } else if (event.type === "resized") {
      this.size = { cols: event.body.cols, rows: event.body.rows };
    }
  }

  private flow(): void {
    this.flowing = true;
    for (const event of this.early.splice(0)) {
      if (this.ended !== null) return;
      this.handle(event);
    }
  }

  private handle(event: HolderEvent): void {
    if (this.ended !== null) return;
    switch (event.type) {
      case "data":
        this.at = { generation: this.at.generation, offset: event.offset + event.bytes.length };
        for (const listener of this.dataListeners) listener(event.bytes);
        break;
      case "respawned":
        // One the stream's position has already passed told it nothing new.
        if (event.body.generation <= this.at.generation) return;
        this.at = { generation: event.body.generation, offset: 0 };
        this.exit = null;
        for (const listener of this.respawnListeners) listener(event.body.generation);
        break;
      case "exited": {
        // The holder sends a generation's exit again after a subscription's `ok`, and an earlier
        // generation's belongs to a process a respawn has replaced.
        const { generation, status } = event.body;
        if (generation !== this.at.generation || this.exit !== null) return;
        const exit = { generation, status };
        this.exit = exit;
        for (const listener of this.exitListeners) listener(exit);
        return;
      }
      case "resized":
        this.size = { cols: event.body.cols, rows: event.body.rows };
        return;
      case "gap":
        this.end("behind");
        this.reader?.end();
        return;
      case "title":
      case "alternate":
      case "refused":
      case "snapshot":
        return;
    }
    this.settleHeld();
  }

  private settleHeld(): void {
    for (const hold of this.held) {
      if (!reached(this.at, hold.at)) continue;
      this.held.delete(hold);
      hold.resolve();
    }
  }

  private end(why: StreamEnd): void {
    if (this.ended !== null) return;
    this.ended = why;
    this.release();
    for (const listener of this.closeListeners) listener(why);
    const error = new Error(`the stream ${why === "behind" ? "fell behind" : "ended"}`);
    for (const hold of this.held) hold.reject(error);
    this.held.clear();
  }

  private report(failure: StreamFailure): void {
    if (this.failing?.what === failure.what) return;
    this.failing = failure;
    for (const listener of this.failureListeners) listener(failure);
  }

  private succeeded(what: string): void {
    if (this.failing?.what === what) this.failing = null;
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataListeners.push(cb);
  }

  onClose(cb: (why: StreamEnd) => void): void {
    if (this.ended !== null) cb(this.ended);
    else this.closeListeners.push(cb);
  }

  /** A failure still failing when this is called is told at once. */
  onFailure(cb: (failure: StreamFailure) => void): void {
    this.failureListeners.push(cb);
    if (this.failing !== null) cb(this.failing);
  }

  onRespawn(cb: (generation: number) => void): void {
    this.respawnListeners.push(cb);
  }

  onExit(cb: (exit: ProgramExit) => void): void {
    this.exitListeners.push(cb);
  }

  get exited(): ProgramExit | null {
    return this.exit;
  }

  write(bytes: Uint8Array): void {
    if (this.ended !== null || bytes.length === 0) return;
    this.control.write(bytes);
  }

  async resize(size: Size): Promise<void> {
    if (this.ended !== null) throw new Error("the stream has closed");
    await this.control.resize(size);
    this.size = size;
  }

  /**
   * Taken on the control connection, and held until this stream has delivered everything before
   * it: rejected, once its close callbacks have run, if the stream closes first.
   */
  async snapshot(): Promise<Snapshot> {
    if (this.ended !== null) throw new Error("the stream has closed");
    let snapshot: Snapshot;
    try {
      snapshot = await this.control.snapshot();
    } catch (error) {
      if (this.ended !== null) throw new Error("the stream has closed", { cause: error });
      throw error;
    }
    if (this.ended !== null) throw new Error("the stream has closed");
    const at = { generation: snapshot.generation, offset: snapshot.offset };
    if (!reached(this.at, at)) {
      await new Promise<void>((resolve, reject) => this.held.add({ at, resolve, reject }));
    }
    return snapshot;
  }

  close(): void {
    this.reader?.end();
    this.end("ended");
  }
}

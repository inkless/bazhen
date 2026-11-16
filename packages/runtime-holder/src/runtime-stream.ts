// A holder terminal's streams. Each stream reads on a connection of its own, subscribed from its
// snapshot. What streams send, and the snapshots they take later, go through one control
// connection per terminal, unsubscribed and holding the writer slot:
//
// - a holder has one writer slot, which every stream of the terminal shares;
// - a snapshot sent on a subscribed connection moves its subscription to the snapshot's offset,
//   so the output between is never sent there, and other views reading it would miss it.

import type {
  Size,
  Snapshot,
  SnapshotAttached,
  SnapshotStream,
  StreamEnd,
  StreamFailure,
} from "@bazhen/core";
import { HOLDER_MAX_REQUEST_BYTES } from "@bazhen/protocol";
import type { HolderClient, HolderEvent } from "./client.ts";

/** Opens a connection to the terminal's holder, sending its events to `onEvent`. */
export type OpenHolder = (
  writer: boolean,
  onEvent: (event: HolderEvent) => void,
) => Promise<HolderClient>;

/** What one write of input may hold, so it fits a connection's unsent cap with room to spare. */
const INPUT_PART = HOLDER_MAX_REQUEST_BYTES;
/** What input frames add to their bytes, at most, for one part. */
const PART_OVERHEAD = 64;

/** Where a stream is: the generation and offset of the next byte it will deliver. */
interface Position {
  readonly generation: number;
  readonly offset: number;
}

const reached = (at: Position, target: Position) =>
  at.generation > target.generation ||
  (at.generation === target.generation && at.offset >= target.offset);

/**
 * One terminal's control connection, shared by its open streams. Opened on first use, and again
 * after it is lost, once the old one's socket has closed, so the holder has freed its writer slot.
 */
export class Control {
  private readonly open: OpenHolder;
  private client: HolderClient | null = null;
  private opening: Promise<HolderClient> | null = null;
  private readonly unsent: Uint8Array[] = [];
  private sending = false;
  private users = 0;
  private readonly failures = new Set<(failure: StreamFailure) => void>();

  constructor(open: OpenHolder) {
    this.open = open;
  }

  /** A stream starts using it: `release` once it closes. */
  acquire(onFailure: (failure: StreamFailure) => void): () => void {
    this.users += 1;
    this.failures.add(onFailure);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.users -= 1;
      this.failures.delete(onFailure);
      if (this.users === 0) {
        this.unsent.length = 0;
        this.client?.end();
      }
    };
  }

  private fail(what: string, cause: unknown): void {
    for (const report of this.failures) report({ what, cause });
  }

  private connection(): Promise<HolderClient> {
    if (this.client?.open === true) return Promise.resolve(this.client);
    this.opening ??= (async () => {
      const old = this.client;
      this.client = null;
      if (old !== null) {
        old.end();
        await old.closed;
      }
      const client = await this.open(true, (event) => {
        if (event.type === "refused") this.fail("input", event.error);
      });
      if (!client.hello.writer) {
        this.fail("input", new Error("another connection holds the terminal's writer slot"));
      }
      this.client = client;
      return client;
    })().finally(() => {
      this.opening = null;
    });
    return this.opening;
  }

  write(bytes: Uint8Array): void {
    for (let at = 0; at < bytes.length; at += INPUT_PART) {
      this.unsent.push(bytes.subarray(at, at + INPUT_PART));
    }
    void this.send();
  }

  /** Sends what is unsent, in order, waiting for room rather than overrunning the connection. */
  private async send(): Promise<void> {
    if (this.sending) return;
    this.sending = true;
    try {
      for (let part = this.unsent[0]; part !== undefined; part = this.unsent[0]) {
        const client = await this.connection();
        if (client.room < part.length + PART_OVERHEAD) await client.drained();
        // Its streams closed meanwhile, and took what was unsent with them.
        if (this.unsent[0] !== part) continue;
        client.input(part);
        this.unsent.shift();
      }
    } catch (error) {
      this.unsent.length = 0;
      this.fail("input", error);
    } finally {
      this.sending = false;
    }
  }

  async resize(size: Size): Promise<void> {
    await (await this.connection()).resize(size);
  }

  async snapshot(): Promise<Snapshot> {
    const { bytes, offset, generation } = await (await this.connection()).snapshot();
    return { vt: bytes, offset, generation };
  }

  /** Hangs up, leaving the holder running: the terminal is closed or the runtime done with it. */
  end(): void {
    this.unsent.length = 0;
    this.client?.end();
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
  private alternate = false;
  private flowing = false;
  private readonly early: HolderEvent[] = [];
  private ended: StreamEnd | null = null;
  private readonly held = new Set<Held>();
  private readonly dataListeners: ((bytes: Uint8Array) => void)[] = [];
  private readonly closeListeners: ((why: StreamEnd) => void)[] = [];
  private readonly alternateListeners: ((on: boolean) => void)[] = [];
  private readonly respawnListeners: ((generation: number) => void)[] = [];
  private readonly failureListeners: ((failure: StreamFailure) => void)[] = [];
  /** What failed last and is still failing, reported once until it succeeds again. */
  private failing: string | null = null;

  constructor(control: Control, size: Size) {
    this.control = control;
    this.size = size;
    this.release = control.acquire((failure) => this.report(failure));
  }

  /** Attaches on `reader`, whose events must come to `event`: its snapshot, then its output. */
  async attach(reader: HolderClient): Promise<SnapshotAttached> {
    this.reader = reader;
    this.alternate = reader.hello.alternate;
    let snapshot: Snapshot | null = null;
    const taken = (event: HolderEvent) => {
      if (event.type !== "snapshot" || snapshot !== null) return false;
      snapshot = { vt: event.bytes, offset: event.offset, generation: event.generation };
      this.at = { generation: event.generation, offset: event.offset };
      return true;
    };
    this.takeSnapshot = taken;
    void reader.ended.then(() => this.end("ended"));
    try {
      await reader.attach();
    } catch (error) {
      this.close();
      throw error;
    }
    const attached = snapshot as Snapshot | null;
    if (attached === null) throw new Error("the holder subscribed the stream without its snapshot");
    // The consumer registers its callbacks in the turn `attach` resolves in; output read meanwhile
    // waits for it.
    setImmediate(() => this.flow());
    return { kind: "snapshot", ...attached, stream: this, alternate: this.alternate };
  }

  private takeSnapshot: (event: HolderEvent) => boolean = () => false;

  /** Where the reader's events come in, in the order the holder sent them. */
  event(event: HolderEvent): void {
    if (this.takeSnapshot(event)) return;
    if (this.flowing) this.handle(event);
    else this.early.push(event);
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
        this.at = { generation: event.body.generation, offset: 0 };
        for (const listener of this.respawnListeners) listener(event.body.generation);
        break;
      case "alternate":
        if (event.body.on === this.alternate) return;
        this.alternate = event.body.on;
        for (const listener of this.alternateListeners) listener(event.body.on);
        break;
      case "resized":
        this.size = { cols: event.body.cols, rows: event.body.rows };
        return;
      case "gap":
        this.end("behind");
        this.reader?.end();
        return;
      case "exited":
      case "title":
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
    if (this.failing === failure.what) return;
    this.failing = failure.what;
    for (const listener of this.failureListeners) listener(failure);
  }

  private succeeded(what: string): void {
    if (this.failing === what) this.failing = null;
  }

  onData(cb: (bytes: Uint8Array) => void): void {
    this.dataListeners.push(cb);
  }

  onClose(cb: (why: StreamEnd) => void): void {
    if (this.ended !== null) cb(this.ended);
    else this.closeListeners.push(cb);
  }

  onAlternate(cb: (alternate: boolean) => void): void {
    this.alternateListeners.push(cb);
  }

  onFailure(cb: (failure: StreamFailure) => void): void {
    this.failureListeners.push(cb);
  }

  onRespawn(cb: (generation: number) => void): void {
    this.respawnListeners.push(cb);
  }

  write(bytes: Uint8Array): void {
    if (this.ended !== null || bytes.length === 0) return;
    this.control.write(bytes);
  }

  async resize(size: Size): Promise<void> {
    if (this.ended !== null) throw new Error("the stream has closed");
    await this.control.resize(size);
    this.size = size;
    this.succeeded("resize");
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

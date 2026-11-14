import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  acceptsInput,
  engage,
  newId,
  release,
  RESPAWN_RESET,
  type AttachmentId,
  type Lease,
  type RuntimeAdapter,
  type RuntimeRef,
  type RuntimeStream,
  type Size,
  type TerminalId,
} from "@bazhen/core";
import {
  HISTORY_LINES,
  PROTOCOL_VERSION,
  TERMINAL_COLOURS,
  type AttachmentMode,
  type EventPayload,
  type StreamServerFrame,
  type TuiTheme,
} from "@bazhen/protocol";
import { failureDetail } from "../commands.ts";
import { classifyInput } from "./input-filter.ts";
import { emulatorScreen, runtimeScreen, type ScreenSource } from "./screen-source.ts";
import { seam, type Held, type Position } from "./seam.ts";

/** One browser view of a terminal, as the hub sees it. */
export interface Viewer {
  readonly mode: AttachmentMode;
  /**
   * Whether the view declares the epoch its input is typed under. One that doesn't, from before
   * protocol 1.30, is held to the epoch of its own grant.
   */
  readonly declaresEpoch: boolean;
  /** The name of the paired device the view is on, if it is on one. */
  readonly deviceName?: string | undefined;
  /** `written` runs once the bytes are written to the view's socket, or the socket has failed. */
  send(bytes: Uint8Array, written?: () => void): void;
  notify(frame: StreamServerFrame): void;
  /** Bytes sent to the view that have not reached it yet. */
  unsent(): number;
  /** The view's stream is over: it should disconnect. */
  close(): void;
}

/** A view ended before it finished opening; it was never told it is attached. */
export class ViewEnded extends Error {
  constructor() {
    super("the view ended while it opened");
    this.name = "ViewEnded";
  }
}

/** A view was turned away before it opened: for want of room, or with no screen to send it. */
export class ViewRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewRefused";
  }
}

export interface HubOptions {
  /** A view this far behind its terminal's output is ended, never sent a stream with a hole. */
  readonly maxUnsentBytes: number;
  /** The most views a terminal may have; one more is turned away. */
  readonly maxViews: number;
  /**
   * The most snapshot bytes not yet written to their views, across every terminal. Over it, views
   * whose snapshots have stalled are ended to make room, and failing that the view that opens is
   * turned away.
   */
  readonly maxSnapshotBytes: number;
  readonly snapshotChunkBytes: number;
  /** A view whose snapshot has had nothing written for this long has stalled. */
  readonly snapshotStallMs: number;
  readonly now: () => number;
}

export const HUB_DEFAULTS: HubOptions = {
  maxUnsentBytes: 4 * 1024 * 1024,
  maxViews: 16,
  // Three of the largest snapshot a 200-column terminal can have. Taking a snapshot briefly needs
  // several times its size again, uncounted here; only one is taken at a time.
  maxSnapshotBytes: 200 * 1024 * 1024,
  snapshotChunkBytes: 1024 * 1024,
  // A link slower than about 100 KB/s.
  snapshotStallMs: 10_000,
  now: () => performance.now(),
};

export type EndReason = EventPayload<"attachment.ended">["reason"];

/** What the hub records about attachments and leases; the daemon writes it to the store. */
export interface AttachmentLog {
  started(attachment: AttachmentId, terminal: TerminalId, mode: AttachmentMode): void;
  ended(attachment: AttachmentId, reason: EndReason): void;
  granted(terminal: TerminalId, attachment: AttachmentId, epoch: number): void;
  /** The epoch of the terminal's last grant, so a new one is always higher. */
  epoch(terminal: TerminalId): number;
  /** The theme the terminal's process was started for, which programs that ask are told. */
  theme(terminal: TerminalId): TuiTheme;
  /** Whether the terminal is being closed, so its client's exit ends views as terminal_closed. */
  closing(terminal: TerminalId): boolean;
}

/** A view's handle on its attachment. */
export interface Attachment {
  readonly id: AttachmentId;
  input(bytes: Uint8Array): void;
  engage(): void;
  /** The epoch the view's following input is typed under. */
  declareEpoch(epoch: number): void;
  resize(size: Size): void;
  leave(reason?: LeaveReason): void;
}

/** Why a view's own side ended: it closed, or its socket stopped answering. */
export type LeaveReason = Extract<EndReason, "client_closed" | "timed_out">;

/** A view's claim on its own earlier attachment, when it reattaches. */
export interface Resume {
  readonly attachmentId: AttachmentId;
  readonly token: string;
}

interface Entry {
  readonly viewer: Viewer;
  /** The digest of the token that lets this view end this attachment when it reattaches. */
  readonly resumeDigest: Buffer;
  size: Size;
  /** The epoch this view was granted the lease at, for a view that declares none. */
  grantedEpoch?: number;
  /** The epoch the view says its input is typed under; a grant never changes it. */
  declaredEpoch?: number;
  /** Live output held while the view's snapshot is on its way, and how many bytes of it. */
  queue?: Held[];
  held: number;
  /**
   * What of the snapshot may still be in the socket's queue, which the view may lag by on top of
   * `maxUnsentBytes`: a large history alone must not end the view. That is the one piece in
   * flight, if any.
   */
  snapshotBytes: number;
  /** Whether it has been told its input was dropped under the current lease. */
  toldDropped?: boolean;
}

/** A view whose snapshot is still being written to its socket. */
interface Loading {
  readonly watched: Watched;
  /** The snapshot's size: all of it is held until the last of it is written. */
  readonly bytes: number;
  /** When a piece of it was last written, or it began. */
  since: number;
  /** Stops waiting for the piece in flight, once the view has ended. */
  wake: () => void;
}

interface Watched {
  readonly terminal: TerminalId;
  readonly stream: RuntimeStream;
  readonly screen: ScreenSource;
  /** Where the stream is: the position of the next byte it delivers. */
  at: Position;
  readonly viewers: Map<AttachmentId, Entry>;
  alternate: boolean;
  lease: Lease;
  /** The terminal's size as last applied. */
  size: Size;
  /** A resize in flight, and the latest size asked for while it runs. */
  resizing?: Promise<void>;
  wanted?: Size;
}

/**
 * At most one runtime client per viewed terminal, however many views are open, with its bytes
 * fanned out to every view (foundation-design §5.4). The lease decides whose size the terminal
 * takes and whose keystrokes reach it (§4.3).
 */
export class TerminalHub {
  private readonly runtime: RuntimeAdapter;
  private readonly log: AttachmentLog;
  private readonly opts: HubOptions;
  private readonly watched = new Map<TerminalId, Promise<Watched>>();
  /** Oldest first. */
  private readonly loading = new Map<AttachmentId, Loading>();

  constructor(runtime: RuntimeAdapter, log: AttachmentLog, opts: HubOptions = HUB_DEFAULTS) {
    this.runtime = runtime;
    this.log = log;
    this.opts = opts;
  }

  /**
   * `resumes` names the view's own earlier attachment, when it reattaches after losing its
   * socket; that one is ended before the view is told who drives, if the token is the one that
   * attachment was given. A view turned away leaves it be.
   */
  async join(ref: RuntimeRef, viewer: Viewer, size: Size, resumes?: Resume): Promise<Attachment> {
    // An observer never sizes the terminal, not even by being the first to open it (§5.4).
    const opening = viewer.mode === "interactive" ? size : null;
    const { watched, opened } = await this.watch(ref, opening);
    const id = newId("att");
    const replaced = resumes && watched.viewers.get(resumes.attachmentId);
    const resumed =
      resumes !== undefined &&
      replaced !== undefined &&
      timingSafeEqual(digest(resumes.token), replaced.resumeDigest);
    if (watched.viewers.size - (resumed ? 1 : 0) >= this.opts.maxViews) {
      this.log.started(id, watched.terminal, viewer.mode);
      this.log.ended(id, "attach_failed");
      throw new ViewRefused(`this terminal already has ${this.opts.maxViews} views open`);
    }
    // From here the view's live output is held, and its snapshot is no older than this.
    const from = watched.at;
    const resumeToken = randomBytes(16).toString("base64url");
    const entry: Entry = {
      viewer,
      size,
      queue: [],
      held: 0,
      snapshotBytes: 0,
      resumeDigest: digest(resumeToken),
    };
    watched.viewers.set(id, entry);
    const taking = watched.screen.snapshot(from);
    this.log.started(id, watched.terminal, viewer.mode);
    const shown = await taking.catch((err: unknown) => {
      if (!watched.viewers.has(id)) throw new ViewEnded();
      this.end(watched, id, "attach_failed");
      throw err;
    });
    if (!watched.viewers.has(id)) throw new ViewEnded();
    const rest = seam(entry.queue ?? [], from, watched.at, shown.at);
    if (rest === null) {
      this.end(watched, id, "attach_failed");
      throw new ViewRefused("this terminal's screen could not be read; reopen it");
    }
    // What the snapshot covers is never sent, so it neither stays held nor counts against the view.
    entry.queue = rest;
    entry.held = rest.reduce((n, item) => n + item.bytes.length, 0);
    if (!this.makeRoom(shown.vt.length)) {
      this.end(watched, id, "attach_failed");
      throw new ViewRefused(
        "too many views are still loading their screens; reopen this terminal in a moment",
      );
    }
    if (resumed && watched.viewers.get(resumes.attachmentId) === replaced) {
      replaced.viewer.close();
      this.end(watched, resumes.attachmentId, "replaced");
    }
    // Not before: a view clears its screen for a snapshot, and one turned away would lose it.
    viewer.notify({ type: "snapshot_start" });
    viewer.notify(leaseFrame(watched, id));
    await this.sendSnapshot(watched, id, entry, shown.vt);
    // The view may have left, or the terminal closed, while its snapshot was sent.
    if (!watched.viewers.has(id)) throw new ViewEnded();
    viewer.notify({ type: "snapshot_end" });
    viewer.notify({ type: "screen", alternate: watched.alternate });
    for (const { bytes } of entry.queue ?? []) viewer.send(bytes);
    delete entry.queue;
    entry.held = 0;
    // The most recent interactive view sizes the terminal while nobody drives it.
    if (!opened) this.fitTo(watched);
    // Last: a view may send input and engage as soon as it is told, and they need the handle
    // returned below.
    viewer.notify({
      type: "attached",
      attachmentId: id,
      protocolVersion: PROTOCOL_VERSION,
      resumeToken,
    });
    return {
      id,
      input: (bytes) => this.input(watched, id, bytes),
      engage: () => this.engage(watched, id),
      declareEpoch: (epoch) => this.declareEpoch(watched, id, epoch),
      resize: (next) => this.resize(watched, id, next),
      leave: (reason = "client_closed") => this.end(watched, id, reason),
    };
  }

  private async watch(
    ref: RuntimeRef,
    size: Size | null,
  ): Promise<{ watched: Watched; opened: boolean }> {
    const existing = this.watched.get(ref.terminalId);
    if (existing !== undefined) return { watched: await existing, opened: false };
    const opening = (async () => {
      const attached = await this.runtime.attach(ref, size, HISTORY_LINES);
      const { stream } = attached;
      const watched: Watched = {
        terminal: ref.terminalId,
        stream,
        screen:
          attached.kind === "history"
            ? emulatorScreen(attached, () => TERMINAL_COLOURS[this.log.theme(ref.terminalId)])
            : runtimeScreen(attached),
        at:
          attached.kind === "history"
            ? { generation: 0, offset: 0 }
            : { generation: attached.generation, offset: attached.offset },
        size: stream.size,
        viewers: new Map(),
        alternate: attached.alternate,
        lease: { holder: null, epoch: this.log.epoch(ref.terminalId) },
      };
      const deliver = (item: Held) => {
        const { bytes } = item;
        watched.screen.write(bytes);
        for (const [id, entry] of watched.viewers) {
          if (entry.queue) {
            entry.queue.push(item);
            entry.held += bytes.length;
          } else entry.viewer.send(bytes);
          const behind = entry.viewer.unsent() - entry.snapshotBytes + entry.held;
          if (behind > this.opts.maxUnsentBytes) {
            this.evict(watched, id, entry);
          }
        }
      };
      stream.onData((bytes) => {
        const at = watched.at;
        watched.at = { ...at, offset: at.offset + bytes.length };
        deliver({ kind: "data", at, bytes });
      });
      stream.onRespawn((generation) => {
        watched.at = { generation, offset: 0 };
        deliver({ kind: "reset", generation, bytes: RESPAWN_BYTES });
      });
      stream.onClose((why) => {
        // The client also exits when its connection to tmux is lost while the terminal lives on.
        const closed = this.log.closing(watched.terminal);
        const reason = closed
          ? "terminal_closed"
          : why === "behind"
            ? "evicted_slow"
            : "disconnected";
        for (const [id, entry] of watched.viewers) {
          this.unload(id);
          dismiss(
            entry,
            reason === "terminal_closed" ? { type: "exit" } : { type: "ended", reason },
          );
          this.log.ended(id, reason);
        }
        watched.viewers.clear();
        watched.screen.dispose();
        this.forget(ref.terminalId, opening);
      });
      stream.onAlternate((alternate) => {
        watched.alternate = alternate;
        for (const entry of watched.viewers.values()) {
          entry.viewer.notify({ type: "screen", alternate });
        }
      });
      stream.onFailure(({ what, cause }) => {
        const message = `${what} failed: ${failureDetail(cause)}`;
        for (const entry of watched.viewers.values())
          entry.viewer.notify({ type: "notice", message });
      });
      return watched;
    })();
    this.watched.set(ref.terminalId, opening);
    opening.catch(() => this.forget(ref.terminalId, opening));
    return { watched: await opening, opened: true };
  }

  /**
   * A piece at a time, each once the last is written. Pieces queued together would be written as
   * one batch, counted unwritten until all of it is, and a view reading slowly would look no
   * different from one that has gone. Each piece is a copy, so a socket that holds on to the one
   * in flight after its view has ended holds only that piece.
   */
  private async sendSnapshot(
    watched: Watched,
    id: AttachmentId,
    entry: Entry,
    shown: Uint8Array,
  ): Promise<void> {
    const loading: Loading = {
      watched,
      bytes: shown.length,
      since: this.opts.now(),
      wake: () => {},
    };
    this.loading.set(id, loading);
    const step = this.opts.snapshotChunkBytes;
    for (let at = 0; at < shown.length && watched.viewers.has(id); at += step) {
      const piece = Buffer.from(shown.subarray(at, at + step));
      entry.snapshotBytes = piece.length;
      await new Promise<void>((resolve) => {
        loading.wake = resolve;
        entry.viewer.send(piece, resolve);
      });
      entry.snapshotBytes = 0;
      loading.since = this.opts.now();
    }
    this.loading.delete(id);
  }

  /**
   * Whether a snapshot of `bytes` may be sent now. Over the cap, views whose snapshots have
   * stalled are ended, oldest first, until it fits, and none are ended if that would not make
   * room; a view still reading its own is never ended for it. A snapshot is never refused while
   * no other is being sent, however large it is.
   */
  private makeRoom(bytes: number): boolean {
    const now = this.opts.now();
    const fits = (held: number) => held === 0 || held + bytes <= this.opts.maxSnapshotBytes;
    let pending = 0;
    let freeable = 0;
    const stalled: [AttachmentId, Loading][] = [];
    for (const [id, loading] of this.loading) {
      pending += loading.bytes;
      if (now - loading.since < this.opts.snapshotStallMs) continue;
      freeable += loading.bytes;
      stalled.push([id, loading]);
    }
    if (!fits(pending - freeable)) return false;
    for (const [id, loading] of stalled) {
      if (fits(pending)) break;
      const entry = loading.watched.viewers.get(id);
      pending -= loading.bytes;
      if (entry !== undefined) this.evict(loading.watched, id, entry);
    }
    return true;
  }

  private unload(id: AttachmentId): void {
    this.loading.get(id)?.wake();
    this.loading.delete(id);
  }

  /** Ends a view that has fallen behind, at a frame boundary; it reattaches for a fresh screen. */
  private evict(watched: Watched, id: AttachmentId, entry: Entry): void {
    dismiss(entry, { type: "ended", reason: "evicted_slow" });
    this.end(watched, id, "evicted_slow");
  }

  private forget(terminal: TerminalId, opening: Promise<Watched>): void {
    if (this.watched.get(terminal) === opening) this.watched.delete(terminal);
  }

  /**
   * Keystrokes reach the terminal only from its driver. Any other view's are dropped, never
   * queued: an interactive view's keystroke takes the lease instead (§4.3), and an observer is
   * told once per lease. Terminal replies never reach the program, and neither replies nor focus
   * and mouse reports count as keystrokes: an old driver's blur must not take the lease back.
   * Input is applied only under the epoch the view declared, and only a keystroke typed under the
   * current epoch takes the lease over. A key typed before its view learnt of a takeover is
   * stale: applying it would send what the user typed for one screen to another, and taking the
   * lease back for it would move the lease on every key while two views type at once.
   */
  private input(watched: Watched, id: AttachmentId, bytes: Uint8Array): void {
    const entry = watched.viewers.get(id);
    if (entry === undefined) return;
    const input = classifyInput(bytes);
    const { declaresEpoch } = entry.viewer;
    const epoch = declaresEpoch ? entry.declaredEpoch : entry.grantedEpoch;
    if (acceptsInput(watched.lease, id, epoch ?? -1)) {
      if (input.bytes.length > 0) watched.stream.write(input.bytes);
      return;
    }
    if (!input.keystrokes) return;
    if (entry.viewer.mode === "interactive") {
      if (!declaresEpoch || epoch === watched.lease.epoch) this.engage(watched, id);
      return;
    }
    if (entry.toldDropped) return;
    entry.toldDropped = true;
    entry.viewer.notify({ type: "input_dropped" });
  }

  private engage(watched: Watched, id: AttachmentId): void {
    const entry = watched.viewers.get(id);
    if (entry === undefined) return;
    const next = engage(watched.lease, id, entry.viewer.mode);
    if (next === watched.lease) return;
    watched.lease = next;
    entry.grantedEpoch = next.epoch;
    this.log.granted(watched.terminal, id, next.epoch);
    this.announceLease(watched);
    this.fitTo(watched);
  }

  private declareEpoch(watched: Watched, id: AttachmentId, epoch: number): void {
    const entry = watched.viewers.get(id);
    if (entry !== undefined) entry.declaredEpoch = epoch;
  }

  private announceLease(watched: Watched): void {
    for (const [id, e] of watched.viewers) {
      e.toldDropped = false;
      e.viewer.notify(leaseFrame(watched, id));
    }
  }

  /** The driver's size, or with no driver the most recent interactive view's (§5.4). */
  private fitTo(watched: Watched): void {
    const views = [...watched.viewers.entries()];
    const driver = views.find(([id]) => id === watched.lease.holder)?.[1];
    const latest = views.findLast(([, e]) => e.viewer.mode === "interactive")?.[1];
    const target = driver ?? latest;
    if (target !== undefined) this.applySize(watched, target.size);
  }

  /** The driver sets the terminal's size; everyone else renders at it (§5.4). */
  private resize(watched: Watched, id: AttachmentId, size: Size): void {
    const entry = watched.viewers.get(id);
    if (entry === undefined) return;
    entry.size = size;
    this.fitTo(watched);
  }

  /**
   * One resize at a time: a dragged window sends many, and only the latest size matters. The
   * size the terminal already has is not applied again, since tmux would redraw every view.
   */
  private applySize(watched: Watched, size: Size): void {
    watched.wanted = size;
    if (watched.resizing !== undefined) return;
    const next = watched.wanted;
    delete watched.wanted;
    if (next.cols === watched.size.cols && next.rows === watched.size.rows) return;
    watched.resizing = watched.stream
      .resize(next)
      // Before the client's redraw at the new size: the PTY resize that prompts it is the last
      // step of the stream's resize, and no output is delivered before this continuation runs.
      .then(() => {
        watched.size = next;
        watched.screen.resize(next);
      })
      .catch((err: unknown) => {
        for (const entry of watched.viewers.values()) {
          entry.viewer.notify({ type: "notice", message: `resize failed: ${failureDetail(err)}` });
        }
      })
      .finally(() => {
        delete watched.resizing;
        if (watched.wanted !== undefined) this.applySize(watched, watched.wanted);
      });
  }

  private end(watched: Watched, id: AttachmentId, reason: EndReason): void {
    if (!watched.viewers.delete(id)) return;
    this.unload(id);
    this.log.ended(id, reason);
    const wasDriver = watched.lease.holder === id;
    watched.lease = release(watched.lease, id);
    if (watched.viewers.size === 0) {
      this.watched.delete(watched.terminal);
      watched.stream.close();
      return;
    }
    if (wasDriver) this.announceLease(watched);
    this.fitTo(watched);
  }
}

const RESPAWN_BYTES = Buffer.from(RESPAWN_RESET);

const digest = (token: string) => createHash("sha256").update(token).digest();

/** Tells a view why its stream is over, and closes it. */
function dismiss(entry: Entry, frame: StreamServerFrame): void {
  entry.viewer.notify(frame);
  entry.viewer.close();
}

function leaseFrame(watched: Watched, id: AttachmentId): StreamServerFrame {
  const { holder, epoch } = watched.lease;
  const driven = holder !== null && holder !== id;
  const driverDevice = driven ? watched.viewers.get(holder)?.viewer.deviceName : undefined;
  return {
    type: "lease",
    driver: holder === id,
    driven,
    epoch,
    ...(driverDevice === undefined ? {} : { driverDevice }),
  };
}

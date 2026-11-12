import {
  acceptsInput,
  engage,
  newId,
  release,
  type AttachmentId,
  type Lease,
  type RuntimeAdapter,
  type RuntimeRef,
  type RuntimeStream,
  type Size,
  type TerminalId,
} from "@bazhen/core";
import type { AttachmentMode, EventPayload, StreamServerFrame } from "@bazhen/protocol";
import { ScreenEmulator } from "./emulator.ts";
import { classifyInput } from "./input-filter.ts";

/** One browser view of a terminal, as the hub sees it. */
export interface Viewer {
  readonly mode: AttachmentMode;
  send(bytes: Uint8Array): void;
  notify(frame: StreamServerFrame): void;
  /** The stream is gone (the terminal closed): the view should disconnect. */
  close(): void;
}

export type EndReason = EventPayload<"attachment.ended">["reason"];

/** What the hub records about attachments and leases; the daemon writes it to the store. */
export interface AttachmentLog {
  started(attachment: AttachmentId, terminal: TerminalId, mode: AttachmentMode): void;
  ended(attachment: AttachmentId, reason: EndReason): void;
  granted(terminal: TerminalId, attachment: AttachmentId, epoch: number): void;
  /** The epoch of the terminal's last grant, so a new one is always higher. */
  epoch(terminal: TerminalId): number;
}

/** A view's handle on its attachment. */
export interface Attachment {
  readonly id: AttachmentId;
  input(bytes: Uint8Array): void;
  engage(): void;
  resize(size: Size): void;
  leave(): void;
}

interface Entry {
  readonly viewer: Viewer;
  size: Size;
  /** The epoch this view was granted the lease at; its input counts only under that epoch. */
  grantedEpoch?: number;
  /** Live bytes held while the view's snapshot is on its way. */
  queue?: Uint8Array[];
  /** Whether it has been told its input was dropped under the current lease. */
  toldDropped?: boolean;
}

interface Watched {
  readonly terminal: TerminalId;
  readonly stream: RuntimeStream;
  readonly emulator: ScreenEmulator;
  readonly viewers: Map<AttachmentId, Entry>;
  lease: Lease;
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
  private readonly watched = new Map<TerminalId, Promise<Watched>>();

  constructor(runtime: RuntimeAdapter, log: AttachmentLog) {
    this.runtime = runtime;
    this.log = log;
  }

  async join(ref: RuntimeRef, viewer: Viewer, size: Size): Promise<Attachment> {
    // An observer never sizes the terminal, not even by being the first to open it (§5.4).
    const opening = viewer.mode === "interactive" ? size : null;
    const { watched, opened } = await this.watch(ref, opening);
    const id = newId("att");
    // A runtime client that has just attached redraws the screen itself; a view that joins an
    // existing one is seeded from a snapshot, its live bytes held until that is sent.
    const entry: Entry = opened ? { viewer, size } : { viewer, size, queue: [] };
    watched.viewers.set(id, entry);
    this.log.started(id, watched.terminal, viewer.mode);
    viewer.notify(leaseFrame(watched, id));
    if (entry.queue !== undefined) {
      try {
        viewer.send(Buffer.from(await this.runtime.snapshot(ref)));
      } catch (err) {
        this.end(watched, id, "attach_failed");
        viewer.notify({ type: "error", message: `could not read the screen: ${String(err)}` });
        viewer.close();
        throw err;
      }
      for (const bytes of entry.queue) viewer.send(bytes);
      delete entry.queue;
    }
    // The most recent interactive view sizes the terminal while nobody drives it.
    if (!opened) this.fitTo(watched);
    // Last: a view may send input and engage as soon as it is told, and they need the handle
    // returned below.
    viewer.notify({ type: "attached", attachmentId: id });
    return {
      id,
      input: (bytes) => this.input(watched, id, bytes),
      engage: () => this.engage(watched, id),
      resize: (next) => this.resize(watched, id, next),
      leave: () => this.leave(watched, id),
    };
  }

  private async watch(
    ref: RuntimeRef,
    size: Size | null,
  ): Promise<{ watched: Watched; opened: boolean }> {
    const existing = this.watched.get(ref.terminalId);
    if (existing !== undefined) return { watched: await existing, opened: false };
    const opening = this.runtime.attach(ref, size).then((stream) => {
      const watched: Watched = {
        terminal: ref.terminalId,
        stream,
        emulator: new ScreenEmulator((reply) => stream.write(reply)),
        viewers: new Map(),
        lease: { holder: null, epoch: this.log.epoch(ref.terminalId) },
      };
      stream.onData((bytes) => {
        watched.emulator.write(bytes);
        for (const entry of watched.viewers.values()) {
          if (entry.queue) entry.queue.push(bytes);
          else entry.viewer.send(bytes);
        }
      });
      stream.onClose(() => {
        for (const [id, entry] of watched.viewers) {
          entry.viewer.notify({ type: "exit" });
          entry.viewer.close();
          this.log.ended(id, "terminal_closed");
        }
        watched.viewers.clear();
        watched.emulator.dispose();
        this.forget(ref.terminalId, opening);
      });
      return watched;
    });
    this.watched.set(ref.terminalId, opening);
    opening.catch(() => this.forget(ref.terminalId, opening));
    return { watched: await opening, opened: true };
  }

  private forget(terminal: TerminalId, opening: Promise<Watched>): void {
    if (this.watched.get(terminal) === opening) this.watched.delete(terminal);
  }

  /**
   * Keystrokes reach the terminal only from its driver. Any other view's are dropped, never
   * queued: an interactive view's keystroke takes the lease instead (§4.3), and an observer is
   * told once per lease. Terminal replies never reach the program, and neither replies nor focus
   * and mouse reports count as keystrokes: an old driver's blur must not take the lease back. The epoch
   * check fences stale input once input frames carry the epoch they were typed under; until then
   * it is the epoch of this view's own grant.
   */
  private input(watched: Watched, id: AttachmentId, bytes: Uint8Array): void {
    const entry = watched.viewers.get(id);
    if (entry === undefined) return;
    const input = classifyInput(bytes);
    if (acceptsInput(watched.lease, id, entry.grantedEpoch ?? -1)) {
      if (input.bytes.length > 0) watched.stream.write(input.bytes);
      return;
    }
    if (!input.keystrokes) return;
    if (entry.viewer.mode === "interactive") {
      this.engage(watched, id);
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

  /** One resize at a time: a dragged window sends many, and only the latest size matters. */
  private applySize(watched: Watched, size: Size): void {
    watched.wanted = size;
    if (watched.resizing !== undefined) return;
    const next = watched.wanted;
    delete watched.wanted;
    watched.resizing = watched.stream
      .resize(next)
      .catch((err: unknown) => {
        for (const entry of watched.viewers.values()) {
          entry.viewer.notify({ type: "error", message: `resize failed: ${String(err)}` });
        }
      })
      .finally(() => {
        delete watched.resizing;
        if (watched.wanted !== undefined) this.applySize(watched, watched.wanted);
      });
  }

  private leave(watched: Watched, id: AttachmentId): void {
    this.end(watched, id, "client_closed");
  }

  private end(watched: Watched, id: AttachmentId, reason: EndReason): void {
    if (!watched.viewers.delete(id)) return;
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

function leaseFrame(watched: Watched, id: AttachmentId): StreamServerFrame {
  return { type: "lease", driver: watched.lease.holder === id, epoch: watched.lease.epoch };
}

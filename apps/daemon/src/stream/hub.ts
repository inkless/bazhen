import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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
import {
  HISTORY_LINES,
  PROTOCOL_VERSION,
  TERMINAL_COLOURS,
  type AttachmentMode,
  type EventPayload,
  type StreamServerFrame,
  type TuiTheme,
} from "@bazhen/protocol";
import { ScreenEmulator } from "./emulator.ts";
import { classifyInput } from "./input-filter.ts";
import { Settle } from "./settle.ts";

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
  send(bytes: Uint8Array): void;
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

export interface HubOptions {
  /** A view this far behind its terminal's output is ended, never sent a stream with a hole. */
  readonly maxUnsentBytes: number;
  /** How long output must pause, or at most how long it may run, before the screen is re-read. */
  readonly screenQuietMs: number;
  readonly screenMaxWaitMs: number;
}

export const HUB_DEFAULTS: HubOptions = {
  maxUnsentBytes: 4 * 1024 * 1024,
  screenQuietMs: 100,
  screenMaxWaitMs: 500,
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
  /** Live bytes held while the view's snapshot is on its way, and how many there are. */
  queue?: Uint8Array[];
  held: number;
  /**
   * What of the snapshot may still be unsent, which the view may lag by on top of
   * `maxUnsentBytes`: a large history alone must not end the view. It shrinks as the socket
   * drains, and never grows back.
   */
  snapshotBytes: number;
  /** Whether it has been told its input was dropped under the current lease. */
  toldDropped?: boolean;
}

interface Watched {
  readonly terminal: TerminalId;
  readonly stream: RuntimeStream;
  readonly emulator: ScreenEmulator;
  readonly viewers: Map<AttachmentId, Entry>;
  /** Re-reads whether the program is on its alternate screen once its output settles. */
  readonly screen: Settle;
  alternate: boolean;
  checkingScreen: boolean;
  /** Output arrived while a check was running, so its answer may already be stale. */
  screenStale: boolean;
  /** Whether the last check failed, so a failing one is reported once, not every time. */
  screenFailed: boolean;
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

  constructor(runtime: RuntimeAdapter, log: AttachmentLog, opts: HubOptions = HUB_DEFAULTS) {
    this.runtime = runtime;
    this.log = log;
    this.opts = opts;
  }

  /**
   * `resumes` names the view's own earlier attachment, when it reattaches after losing its
   * socket; that one is ended before the view is told who drives, if the token is the one that
   * attachment was given.
   */
  async join(ref: RuntimeRef, viewer: Viewer, size: Size, resumes?: Resume): Promise<Attachment> {
    // An observer never sizes the terminal, not even by being the first to open it (§5.4).
    const opening = viewer.mode === "interactive" ? size : null;
    const { watched, opened } = await this.watch(ref, opening);
    const id = newId("att");
    // From here the view's live bytes are held, and the snapshot covers every byte before them.
    const queue: Uint8Array[] = [];
    const resumeToken = randomBytes(16).toString("base64url");
    const entry: Entry = {
      viewer,
      size,
      queue,
      held: 0,
      snapshotBytes: 0,
      resumeDigest: digest(resumeToken),
    };
    watched.viewers.set(id, entry);
    const replaced = resumes && watched.viewers.get(resumes.attachmentId);
    if (resumes && replaced && timingSafeEqual(digest(resumes.token), replaced.resumeDigest)) {
      replaced.viewer.close();
      this.end(watched, resumes.attachmentId, "replaced");
    }
    const snapshot = watched.emulator.snapshot();
    this.log.started(id, watched.terminal, viewer.mode);
    viewer.notify(leaseFrame(watched, id));
    viewer.notify({ type: "snapshot_start" });
    const shown = Buffer.from(await snapshot);
    entry.snapshotBytes = shown.length;
    viewer.send(shown);
    // The view may have left, or the terminal closed, while its snapshot was sent.
    if (!watched.viewers.has(id)) throw new ViewEnded();
    viewer.notify({ type: "snapshot_end" });
    viewer.notify({ type: "screen", alternate: watched.alternate });
    for (const bytes of queue) viewer.send(bytes);
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
      const { stream, history, alternate } = await this.runtime.attach(ref, size, HISTORY_LINES);
      const watched: Watched = {
        terminal: ref.terminalId,
        stream,
        emulator: new ScreenEmulator(
          stream.size,
          (reply) => stream.write(reply),
          () => TERMINAL_COLOURS[this.log.theme(ref.terminalId)],
        ),
        size: stream.size,
        viewers: new Map(),
        screen: new Settle(this.opts.screenQuietMs, this.opts.screenMaxWaitMs, () =>
          this.checkScreen(watched),
        ),
        alternate,
        checkingScreen: false,
        screenStale: false,
        screenFailed: false,
        lease: { holder: null, epoch: this.log.epoch(ref.terminalId) },
      };
      // Before any of the client's output, whose first redraw paints the screen below it.
      watched.emulator.seed(history);
      stream.onData((bytes) => {
        watched.emulator.write(bytes);
        watched.screen.poke();
        for (const [id, entry] of watched.viewers) {
          if (entry.queue) {
            entry.queue.push(bytes);
            entry.held += bytes.length;
          } else entry.viewer.send(bytes);
          const unsent = entry.viewer.unsent();
          entry.snapshotBytes = Math.min(entry.snapshotBytes, unsent);
          const behind = unsent - entry.snapshotBytes + entry.held;
          if (behind > this.opts.maxUnsentBytes) {
            this.evict(watched, id, entry);
          }
        }
      });
      stream.onClose(() => {
        // The client also exits when its connection to tmux is lost while the terminal lives on.
        const closed = this.log.closing(watched.terminal);
        for (const [id, entry] of watched.viewers) {
          dismiss(entry, closed ? { type: "exit" } : { type: "ended", reason: "disconnected" });
          this.log.ended(id, closed ? "terminal_closed" : "disconnected");
        }
        watched.viewers.clear();
        watched.screen.dispose();
        watched.emulator.dispose();
        this.forget(ref.terminalId, opening);
      });
      return watched;
    })();
    this.watched.set(ref.terminalId, opening);
    opening.catch(() => this.forget(ref.terminalId, opening));
    return { watched: await opening, opened: true };
  }

  /** Ends a view that has fallen behind, at a frame boundary; it reattaches for a fresh screen. */
  private evict(watched: Watched, id: AttachmentId, entry: Entry): void {
    dismiss(entry, { type: "ended", reason: "evicted_slow" });
    this.end(watched, id, "evicted_slow");
  }

  /**
   * One check at a time: a busy terminal settles every half second whether or not it changed. A
   * check asked for while one runs is run after it, since the screen may have switched since.
   */
  private checkScreen(watched: Watched): void {
    if (watched.checkingScreen) {
      watched.screenStale = true;
      return;
    }
    watched.checkingScreen = true;
    watched.screenStale = false;
    watched.stream
      .alternateScreen()
      .then(
        (alternate) => {
          watched.screenFailed = false;
          if (alternate === watched.alternate) return;
          watched.alternate = alternate;
          for (const entry of watched.viewers.values()) {
            entry.viewer.notify({ type: "screen", alternate });
          }
        },
        (err: unknown) => {
          if (watched.screenFailed) return;
          watched.screenFailed = true;
          for (const entry of watched.viewers.values()) {
            entry.viewer.notify({ type: "notice", message: `screen check failed: ${String(err)}` });
          }
        },
      )
      .finally(() => {
        watched.checkingScreen = false;
        if (watched.screenStale && this.watched.has(watched.terminal)) this.checkScreen(watched);
      });
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
        watched.emulator.resize(next);
      })
      .catch((err: unknown) => {
        for (const entry of watched.viewers.values()) {
          entry.viewer.notify({ type: "notice", message: `resize failed: ${String(err)}` });
        }
      })
      .finally(() => {
        delete watched.resizing;
        if (watched.wanted !== undefined) this.applySize(watched, watched.wanted);
      });
  }

  private end(watched: Watched, id: AttachmentId, reason: EndReason): void {
    if (!watched.viewers.delete(id)) return;
    this.log.ended(id, reason);
    const wasDriver = watched.lease.holder === id;
    watched.lease = release(watched.lease, id);
    if (watched.viewers.size === 0) {
      this.watched.delete(watched.terminal);
      watched.screen.dispose();
      watched.stream.close();
      return;
    }
    if (wasDriver) this.announceLease(watched);
    this.fitTo(watched);
  }
}

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

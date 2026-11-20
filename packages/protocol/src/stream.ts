import { z } from "zod";
import { ExitStatus } from "./agents.ts";
import { AttachmentMode, Id } from "./ids.ts";

/**
 * How much history above its screen a terminal keeps unless `terminals.history_lines` says
 * otherwise, and what a view keeps when its daemon doesn't say (foundation-design §12 item 2).
 */
export const HISTORY_LINES = 10_000;

/** The most rows a view or a terminal can have. */
export const MAX_ROWS = 1000;

/** The largest frame a view may send: a keystroke burst or a paste, nothing a person types. */
export const STREAM_FRAME_MAX_BYTES = 1 << 20;

const Size = {
  cols: z.number().int().min(2).max(1000),
  rows: z.number().int().min(2).max(MAX_ROWS),
};

/**
 * Text frames a view sends on `/v1/terminals/:id/stream`; its keystrokes are binary frames
 * (foundation-design §5.3). `hello` comes first and carries the view's size.
 */
export const StreamClientFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    /**
     * The protocol id of the build the view's page is from. The daemon refuses a view of another
     * build, before it can misread a frame or send a key the daemon reads otherwise.
     */
    protocolId: z.string().optional(),
    mode: AttachmentMode,
    ...Size,
    /**
     * The view's own earlier attachment and the resume token it was given, when it reattaches
     * after losing its socket. That one is ended first, so a lease it still held is free again
     * rather than held by a socket that is gone. Attachment ids are in the event
     * stream; only the token proves the attachment was this view's.
     */
    resumes: z.object({ attachmentId: Id("att"), token: z.string().max(64) }).optional(),
  }),
  z.object({ type: z.literal("resize"), ...Size }),
  /** The user clicked, tapped or focused this view: it takes the lease (§4.3). */
  z.object({ type: z.literal("engage") }),
  /**
   * The lease epoch the view's following input frames are typed under: sent once `attached`
   * arrives, for the latest `lease`, and on every `lease` after it, a lost lease included. Input
   * under any other epoch is dropped, and only a keystroke typed under the current epoch takes
   * the lease over (§4.3).
   */
  z.object({ type: z.literal("epoch"), epoch: z.number().int().nonnegative() }),
  /** Asks for a `pong`, so a view can tell its socket has silently died. */
  z.object({ type: z.literal("ping") }),
]);
export type StreamClientFrame = z.infer<typeof StreamClientFrame>;

/** Text frames the daemon sends; the terminal's output is binary frames, untouched. */
export const StreamServerFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("attached"),
    attachmentId: Id("att"),
    /**
     * What lets this view end this attachment when it reattaches (`hello.resumes`). Sent only
     * here: never in an event, a snapshot or a log. Absent from an older daemon.
     */
    resumeToken: z.string().optional(),
  }),
  /** Who drives now. A view that isn't the driver shows "viewing" and sends no input. */
  z.object({
    type: z.literal("lease"),
    driver: z.boolean(),
    epoch: z.number().int().nonnegative(),
    /** Whether another view drives; absent from an older daemon. */
    driven: z.boolean().optional(),
    /**
     * The name of the paired device another view drives from; absent when it is on none, or
     * from an older daemon.
     */
    driverDevice: z.string().optional(),
  }),
  z.object({ type: z.literal("pong") }),
  /**
   * The binary frames between these two are the terminal's history and screen as the daemon
   * holds them; live output follows, with no gap and no repeat (§5.3, §5.9).
   */
  z.object({
    type: z.literal("snapshot_start"),
    /**
     * How much history above its screen the terminal keeps, which the view keeps too as output
     * scrolls; absent from an older daemon, whose terminals keep `HISTORY_LINES`.
     */
    historyLines: z.number().int().nonnegative().optional(),
  }),
  z.object({ type: z.literal("snapshot_end") }),
  /** Applied grid, ordered with the binary output that uses it. */
  z.object({
    type: z.literal("geometry"),
    cols: z.int().min(1).max(1000),
    rows: z.int().min(1).max(MAX_ROWS),
  }),
  /** Input from a view that wasn't the driver was dropped, never queued. */
  z.object({ type: z.literal("input_dropped") }),
  /**
   * Whether the program is on its alternate screen, for a terminal whose runtime keeps its views
   * on their normal screen, where they have scrollback, as tmux does (§5.9): sent after the
   * snapshot and whenever it changes. A holder's views are never sent one, since their bytes carry
   * each switch.
   */
  z.object({ type: z.literal("screen"), alternate: z.boolean() }),
  /**
   * The terminal's process exited, after the last of the output it printed: the process of
   * `generation`, as a respawn numbers them. The terminal goes on, and a respawn may follow on the
   * same view; a view that only shows a running program ends here.
   */
  z.object({
    type: z.literal("exited"),
    generation: z.number().int().nonnegative(),
    exit: ExitStatus,
  }),
  /** The terminal closed, and the view with it. */
  z.object({ type: z.literal("closed") }),
  /**
   * The daemon ended this view while the terminal goes on: it fell too far behind its output, or
   * the daemon's client lost the terminal. Reattaching opens a fresh snapshot (§5.3).
   */
  z.object({ type: z.literal("ended"), reason: z.enum(["evicted_slow", "disconnected"]) }),
  /** The view can't go on: the daemon refused it or lost its terminal. */
  z.object({ type: z.literal("error"), message: z.string() }),
  /** Something went wrong that the view can live with, such as a resize the runtime refused. */
  z.object({ type: z.literal("notice"), message: z.string() }),
]);
export type StreamServerFrame = z.infer<typeof StreamServerFrame>;

import { z } from "zod";
import { AttachmentMode, Id } from "./ids.ts";
import { ProtocolVersion } from "./version.ts";

/**
 * The version from which a view declares its epoch and asks for pongs, and from which a daemon
 * reads both. Either side sends those frames only to a peer at least this new.
 */
export const EPOCH_FRAMES_SINCE = "1.30";

const Size = { cols: z.number().int().min(2).max(1000), rows: z.number().int().min(2).max(1000) };

/**
 * Text frames a view sends on `/v1/terminals/:id/stream`; its keystrokes are binary frames
 * (foundation-design §5.3). `hello` comes first and carries the view's size.
 */
export const StreamClientFrame = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("hello"),
    protocolVersion: ProtocolVersion,
    mode: AttachmentMode,
    ...Size,
    /**
     * The view's own earlier attachment and the resume token it was given, when it reattaches
     * after losing its socket. That one is ended first, so a lease it still held is free again
     * rather than held by a socket that is gone (since 1.30). Attachment ids are in the event
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
    /** The daemon's protocol; absent before 1.30. */
    protocolVersion: ProtocolVersion.optional(),
    /**
     * What lets this view end this attachment when it reattaches (`hello.resumes`). Sent only
     * here: never in an event, a snapshot or a log. Absent before 1.30.
     */
    resumeToken: z.string().optional(),
  }),
  /** Who drives now. A view that isn't the driver shows "viewing" and sends no input. */
  z.object({
    type: z.literal("lease"),
    driver: z.boolean(),
    epoch: z.number().int().nonnegative(),
    /** Whether another view drives; absent from a daemon before 1.30. */
    driven: z.boolean().optional(),
  }),
  z.object({ type: z.literal("pong") }),
  /**
   * The binary frames between these two are the terminal's history and screen as the daemon
   * holds them; live output follows, with no gap and no repeat (§5.3, §5.9).
   */
  z.object({ type: z.literal("snapshot_start") }),
  z.object({ type: z.literal("snapshot_end") }),
  /** Input from a view that wasn't the driver was dropped, never queued. */
  z.object({ type: z.literal("input_dropped") }),
  /**
   * Whether the program is on its alternate screen. A view can't tell for itself: the daemon's
   * client keeps it on its normal screen, where it has scrollback (§5.9). Sent after the snapshot
   * and whenever it changes.
   */
  z.object({ type: z.literal("screen"), alternate: z.boolean() }),
  /** The terminal closed. */
  z.object({ type: z.literal("exit") }),
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

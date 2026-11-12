import { z } from "zod";
import { AttachmentMode, Id } from "./ids.ts";
import { ProtocolVersion } from "./version.ts";

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
  }),
  z.object({ type: z.literal("resize"), ...Size }),
  /** The user clicked, tapped or focused this view: it takes the lease (§4.3). */
  z.object({ type: z.literal("engage") }),
]);
export type StreamClientFrame = z.infer<typeof StreamClientFrame>;

/** Text frames the daemon sends; the terminal's output is binary frames, untouched. */
export const StreamServerFrame = z.discriminatedUnion("type", [
  z.object({ type: z.literal("attached"), attachmentId: Id("att") }),
  /** Who drives now. A view that isn't the driver shows "viewing" and sends no input. */
  z.object({
    type: z.literal("lease"),
    driver: z.boolean(),
    epoch: z.number().int().nonnegative(),
  }),
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

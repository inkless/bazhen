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
  /** Input from a view that wasn't the driver was dropped, never queued. */
  z.object({ type: z.literal("input_dropped") }),
  z.object({ type: z.literal("exit") }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type StreamServerFrame = z.infer<typeof StreamServerFrame>;

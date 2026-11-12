import { z } from "zod";

/** A Bazhen id on the wire: the prefix, then a UUIDv7 (foundation-design §3). */
export const Id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$`));

/** Whether a view may drive its terminal, or only watch it (foundation-design §4.2). */
export const AttachmentMode = z.enum(["observe", "interactive"]);
export type AttachmentMode = z.infer<typeof AttachmentMode>;

export const EnvironmentKind = z.enum(["local", "opencode-server"]);
export type EnvironmentKind = z.infer<typeof EnvironmentKind>;

/**
 * Every mutation carries a key chosen by the client; repeating it returns the first answer
 * instead of acting twice (foundation-design §5.1).
 */
export const IdempotencyKey = z.string().min(1).max(200);

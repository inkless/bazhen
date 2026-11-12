import { z } from "zod";

/** A Bazhen id on the wire: the prefix, then a UUIDv7 (foundation-design §3). */
export const Id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f]{12}7[0-9a-f]{3}[89ab][0-9a-f]{15}$`));

export const EnvironmentKind = z.enum(["local", "opencode-server"]);
export type EnvironmentKind = z.infer<typeof EnvironmentKind>;

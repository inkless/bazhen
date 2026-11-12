import { z } from "zod";

export * from "./states.ts";

/**
 * Major.minor. Within one major version, changes are additive only: add messages and optional
 * fields, never rename, remove or tighten what has shipped. Bump the minor in the same commit as
 * any addition; clients negotiate on it.
 */
export const PROTOCOL_VERSION = "1.0";

export const ProtocolVersion = z.string().regex(/^\d+\.\d+$/);

export const RuntimeHealthState = z.enum(["healthy", "unreachable", "not-running"]);
export type RuntimeHealthState = z.infer<typeof RuntimeHealthState>;

export const HealthResponse = z.object({
  status: z.literal("ok"),
  appVersion: z.string(),
  protocolVersion: ProtocolVersion,
  schemaVersion: z.number().int().nonnegative(),
  runtime: z.object({
    kind: z.literal("tmux"),
    state: RuntimeHealthState,
    version: z.string().nullable(),
  }),
});
export type HealthResponse = z.infer<typeof HealthResponse>;

const major = (v: string) => v.split(".")[0];

/** True when a peer speaking `peer` can talk to this build: same major version. */
export function isCompatible(peer: string, ours: string = PROTOCOL_VERSION): boolean {
  return ProtocolVersion.safeParse(peer).success && major(peer) === major(ours);
}

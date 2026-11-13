import { z } from "zod";

/**
 * Major.minor. Within one major version, changes are additive only: add messages and optional
 * fields, never rename, remove or tighten what has shipped. Bump the minor in the same commit as
 * any addition; clients negotiate on it.
 */
export const PROTOCOL_VERSION = "1.23";

export const ProtocolVersion = z.string().regex(/^\d+\.\d+$/);

const major = (v: string) => v.split(".")[0];

/** True when a peer speaking `peer` can talk to this build: same major version. */
export function isCompatible(peer: string, ours: string = PROTOCOL_VERSION): boolean {
  return ProtocolVersion.safeParse(peer).success && major(peer) === major(ours);
}

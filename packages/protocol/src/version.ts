import { z } from "zod";

/**
 * Major.minor, for a contract whose peers outlive a build: the hook client and the holder.
 * Digits are `[0-9]`: in some regex engines a peer may use, `\d` matches any script's digits.
 */
export const ProtocolVersion = z.string().regex(/^[0-9]+\.[0-9]+$/);

const major = (v: string) => v.split(".")[0];

/** True when a peer speaking `peer` can talk to one speaking `ours`: the same major version. */
export function isCompatible(peer: string, ours: string): boolean {
  return ProtocolVersion.safeParse(peer).success && major(peer) === major(ours);
}

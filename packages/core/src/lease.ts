import type { AttachmentId } from "./ids.ts";

export type AttachmentMode = "observe" | "interactive";

/**
 * Input authority over one terminal (foundation-design §4.3). The epoch survives a release, so
 * every grant gets a higher epoch than any before it on that terminal.
 */
export interface Lease {
  readonly holder: AttachmentId | null;
  readonly epoch: number;
}

export const NO_LEASE: Lease = { holder: null, epoch: 0 };

/** An engaged interactive view takes the lease at once; an observer never holds it. */
export function engage(lease: Lease, by: AttachmentId, mode: AttachmentMode): Lease {
  if (mode === "observe" || lease.holder === by) return lease;
  return { holder: by, epoch: lease.epoch + 1 };
}

/** The lease ends with its attachment; there is no time-based expiry. */
export function release(lease: Lease, attachment: AttachmentId): Lease {
  return lease.holder === attachment ? { holder: null, epoch: lease.epoch } : lease;
}

/** Input is applied only from the driver, at the epoch it was granted; anything else is dropped. */
export function acceptsInput(lease: Lease, from: AttachmentId, epoch: number): boolean {
  return lease.holder === from && lease.epoch === epoch;
}

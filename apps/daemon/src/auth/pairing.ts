import { createHash, randomInt, timingSafeEqual } from "node:crypto";
import { PAIRING_ALPHABET, PAIRING_CODE_LENGTH } from "@bazhen/protocol";

/** foundation-design §12 item 4. */
export const CODE_LIFETIME_MS = 5 * 60 * 1000;
export const ATTEMPTS_PER_ORIGIN = 5;
/** Origin is the client's to choose, so the window across all of them is bounded too. */
export const ATTEMPTS_OVERALL = 10;
/**
 * Failures, from anywhere, that burn the live code; `bazhen pair` must then issue another. Enough
 * that a client faking an allowed Origin can't easily keep everyone from pairing, still nothing
 * against 40 bits.
 */
export const FAILURES_PER_CODE = 20;
const WINDOW_MS = 60 * 1000;

export type Attempt =
  | { readonly kind: "paired" }
  | { readonly kind: "failed" }
  | { readonly kind: "rate_limited"; readonly retryAfterSeconds: number };

/**
 * Where an attempt came from. LAN attempts are keyed by the peer's address and counted apart, so
 * a guest on the LAN can neither spend loopback's attempts nor burn the code for loopback.
 */
export type Bucket = "loopback" | "lan";

interface LiveCode {
  readonly hash: Buffer;
  readonly expiresAt: number;
  readonly failures: Record<Bucket, number>;
}

interface Window {
  start: number;
  count: number;
}

interface Limits {
  overall: Window;
  readonly perKey: Map<string, Window>;
}

const freshLimits = (): Limits => ({ overall: { start: 0, count: 0 }, perKey: new Map() });

const digest = (code: string) => createHash("sha256").update(code).digest();

/** What a person might type for a code: any case, with spaces or dashes between the groups. */
export const normalizeCode = (typed: string) => typed.toUpperCase().replace(/[\s-]/g, "");

/**
 * The one live pairing code, held as its hash, and the attempt windows that guard it. Nothing
 * here is persisted: a restarted daemon has no code until `bazhen pair` asks for one.
 */
export class PairingCodes {
  private live: LiveCode | undefined;
  private readonly limits: Record<Bucket, Limits> = { loopback: freshLimits(), lan: freshLimits() };
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  constructor(opts: { now?: () => number; log?: (line: string) => void } = {}) {
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? console.log;
  }

  /** A new code, replacing any earlier one. */
  issue(): { code: string; expiresAt: Date } {
    let code = "";
    for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
      code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
    }
    const expiresAt = this.now() + CODE_LIFETIME_MS;
    this.live = { hash: digest(code), expiresAt, failures: { loopback: 0, lan: 0 } };
    return { code, expiresAt: new Date(expiresAt) };
  }

  /**
   * Tries `typed` against the live code; a match uses it up. `key` is what attempts are limited
   * by: the Origin on loopback, the peer's address on the LAN.
   */
  attempt(typed: string, key: string, bucket: Bucket = "loopback"): Attempt {
    const now = this.now();
    const limited = this.count(now, key, this.limits[bucket]);
    if (limited !== null) return { kind: "rate_limited", retryAfterSeconds: limited };
    const live = this.live;
    // Hashing both sides gives equal lengths, so the comparison's time says nothing of the code.
    const matches = live !== undefined && timingSafeEqual(digest(normalizeCode(typed)), live.hash);
    if (live === undefined || now >= live.expiresAt) {
      this.live = undefined;
      return { kind: "failed" };
    }
    if (live.failures[bucket] >= FAILURES_PER_CODE) return { kind: "failed" };
    if (matches) {
      this.live = undefined;
      return { kind: "paired" };
    }
    live.failures[bucket]++;
    if (live.failures[bucket] >= FAILURES_PER_CODE) {
      this.log(
        `pairing: the code was burned for ${bucket} after ${FAILURES_PER_CODE} failed attempts`,
      );
    }
    return { kind: "failed" };
  }

  /** Counts an attempt, or answers how many seconds until one is allowed again. */
  private count(now: number, key: string, limits: Limits): number | null {
    for (const [k, w] of limits.perKey) {
      if (now - w.start >= WINDOW_MS) limits.perKey.delete(k);
    }
    if (now - limits.overall.start >= WINDOW_MS) limits.overall = { start: now, count: 0 };
    const mine = limits.perKey.get(key) ?? { start: now, count: 0 };
    const waits: number[] = [];
    if (mine.count >= ATTEMPTS_PER_ORIGIN) waits.push(mine.start + WINDOW_MS - now);
    if (limits.overall.count >= ATTEMPTS_OVERALL) {
      waits.push(limits.overall.start + WINDOW_MS - now);
    }
    if (waits.length > 0) return Math.ceil(Math.max(...waits) / 1000);
    mine.count++;
    limits.overall.count++;
    limits.perKey.set(key, mine);
    return null;
  }
}

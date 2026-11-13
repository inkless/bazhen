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

interface LiveCode {
  readonly hash: Buffer;
  readonly expiresAt: number;
  failures: number;
}

interface Window {
  start: number;
  count: number;
}

const digest = (code: string) => createHash("sha256").update(code).digest();

/** What a person might type for a code: any case, with spaces or dashes between the groups. */
export const normalizeCode = (typed: string) => typed.toUpperCase().replace(/[\s-]/g, "");

/**
 * The one live pairing code, held as its hash, and the attempt windows that guard it. Nothing
 * here is persisted: a restarted daemon has no code until `bazhen pair` asks for one.
 */
export class PairingCodes {
  private live: LiveCode | undefined;
  private overall: Window = { start: 0, count: 0 };
  private readonly perOrigin = new Map<string, Window>();
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
    this.live = { hash: digest(code), expiresAt, failures: 0 };
    return { code, expiresAt: new Date(expiresAt) };
  }

  /** Tries `typed` against the live code; a match uses it up. */
  attempt(typed: string, origin: string): Attempt {
    const now = this.now();
    const limited = this.count(now, origin);
    if (limited !== null) return { kind: "rate_limited", retryAfterSeconds: limited };
    const live = this.live;
    // Hashing both sides gives equal lengths, so the comparison's time says nothing of the code.
    const matches = live !== undefined && timingSafeEqual(digest(normalizeCode(typed)), live.hash);
    if (live === undefined || now >= live.expiresAt) {
      this.live = undefined;
      return { kind: "failed" };
    }
    if (matches) {
      this.live = undefined;
      return { kind: "paired" };
    }
    live.failures++;
    if (live.failures >= FAILURES_PER_CODE) {
      this.live = undefined;
      this.log(`pairing: the code was burned after ${FAILURES_PER_CODE} failed attempts`);
    }
    return { kind: "failed" };
  }

  /** Counts an attempt, or answers how many seconds until one is allowed again. */
  private count(now: number, origin: string): number | null {
    for (const [key, w] of this.perOrigin) {
      if (now - w.start >= WINDOW_MS) this.perOrigin.delete(key);
    }
    if (now - this.overall.start >= WINDOW_MS) this.overall = { start: now, count: 0 };
    const mine = this.perOrigin.get(origin) ?? { start: now, count: 0 };
    const waits: number[] = [];
    if (mine.count >= ATTEMPTS_PER_ORIGIN) waits.push(mine.start + WINDOW_MS - now);
    if (this.overall.count >= ATTEMPTS_OVERALL) waits.push(this.overall.start + WINDOW_MS - now);
    if (waits.length > 0) return Math.ceil(Math.max(...waits) / 1000);
    mine.count++;
    this.overall.count++;
    this.perOrigin.set(origin, mine);
    return null;
  }
}

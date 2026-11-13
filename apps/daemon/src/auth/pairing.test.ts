import { describe, expect, it } from "vitest";
import { PAIRING_ALPHABET } from "@bazhen/protocol";
import {
  ATTEMPTS_OVERALL,
  ATTEMPTS_PER_ORIGIN,
  CODE_LIFETIME_MS,
  PairingCodes,
} from "./pairing.ts";

const A = "http://127.0.0.1:5173";
/** Far enough apart that 20 attempts from 3 origins stay under both limits, inside the code's life. */
const SPACED_MS = 7_000;

function codes() {
  const clock = { now: 1_000_000 };
  const logged: string[] = [];
  const pairing = new PairingCodes({ now: () => clock.now, log: (l) => logged.push(l) });
  return { pairing, clock, logged };
}

/** A wrong guess at `code`, one character off. */
const otherThan = (code: string) => (code[0] === "A" ? "B" : "A") + code.slice(1);

describe("PairingCodes", () => {
  it("issues 8 characters of base32", () => {
    const { code } = codes().pairing.issue();
    expect(code).toHaveLength(8);
    expect(code.split("").every((ch) => PAIRING_ALPHABET.includes(ch))).toBe(true);
  });

  it("accepts the code as a person types it, in lower case or grouped with a dash", () => {
    const { pairing } = codes();
    const { code } = pairing.issue();
    expect(pairing.attempt(`${code.slice(0, 4)}-${code.slice(4)}`.toLowerCase(), A).kind).toBe(
      "paired",
    );
  });

  it("accepts a code once", () => {
    const { pairing } = codes();
    const { code } = pairing.issue();
    expect([pairing.attempt(code, A).kind, pairing.attempt(code, A).kind]).toEqual([
      "paired",
      "failed",
    ]);
  });

  it("refuses a code from the moment it expires", () => {
    const { pairing, clock } = codes();
    const { code } = pairing.issue();
    clock.now += CODE_LIFETIME_MS;
    expect(pairing.attempt(code, A).kind).toBe("failed");
  });

  it("refuses a code that a newer one replaced", () => {
    const { pairing } = codes();
    const first = pairing.issue().code;
    pairing.issue();
    expect(pairing.attempt(first, A).kind).toBe("failed");
  });

  it("burns the code after 20 failures, however many origins they came from", () => {
    const { pairing, logged, clock } = codes();
    const { code } = pairing.issue();
    for (let i = 0; i < 20; i++) {
      clock.now += SPACED_MS;
      expect(pairing.attempt(otherThan(code), `http://host-${i % 3}`).kind).toBe("failed");
    }
    expect(pairing.attempt(code, "http://host-new").kind).toBe("failed");
    expect(logged).toHaveLength(1);
    expect(logged[0]).not.toContain(code);
  });

  it("keeps the code through fewer than 20 failures", () => {
    const { pairing, clock } = codes();
    const { code } = pairing.issue();
    for (let i = 0; i < 19; i++) {
      clock.now += SPACED_MS;
      pairing.attempt(otherThan(code), `http://host-${i % 3}`);
    }
    expect(pairing.attempt(code, A).kind).toBe("paired");
  });

  it("refuses a sixth attempt from one origin within a minute without trying the code", () => {
    const { pairing, clock } = codes();
    for (let i = 0; i < ATTEMPTS_PER_ORIGIN; i++) pairing.attempt(pairing.issue().code, A);
    const { code } = pairing.issue();
    clock.now += 20_000;
    expect(pairing.attempt(code, A)).toEqual({ kind: "rate_limited", retryAfterSeconds: 40 });
    // Not compared, so not used up: another origin can still pair with it.
    expect(pairing.attempt(code, "http://other").kind).toBe("paired");
  });

  it("bounds attempts across all origins, which a client can make up", () => {
    const { pairing } = codes();
    for (let i = 0; i < ATTEMPTS_OVERALL; i++) {
      pairing.attempt(pairing.issue().code, `http://host-${i}`);
    }
    expect(pairing.attempt(pairing.issue().code, "http://fresh").kind).toBe("rate_limited");
  });

  it("allows attempts again once the minute is over", () => {
    const { pairing, clock } = codes();
    for (let i = 0; i < ATTEMPTS_PER_ORIGIN; i++) pairing.attempt(pairing.issue().code, A);
    clock.now += 60_000;
    expect(pairing.attempt(pairing.issue().code, A).kind).toBe("paired");
  });
});

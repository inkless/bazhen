import { describe, expect, it } from "vitest";
import { PAIRING_ALPHABET, PairRequest, PairingCodeResponse } from "./devices.ts";

describe("pairing schemas", () => {
  it("draws codes from the 32 distinct characters of RFC 4648 base32", () => {
    expect(new Set(PAIRING_ALPHABET).size).toBe(32);
    expect(PAIRING_ALPHABET).toMatch(/^[A-Z2-7]+$/);
  });

  it("refuses a code reply that isn't 8 characters", () => {
    const reply = { code: "ABCD234", expiresAt: "2026-11-12T00:05:00.000Z", origins: [] };
    expect(PairingCodeResponse.safeParse(reply).success).toBe(false);
  });

  it("refuses a device name longer than 64 characters", () => {
    expect(PairRequest.safeParse({ code: "ABCD2345", name: "x".repeat(65) }).success).toBe(false);
  });
});

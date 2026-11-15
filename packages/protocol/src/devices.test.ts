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

  it("takes a code reply with the LAN listener's address and fingerprint, or without", () => {
    const reply = { code: "ABCD2345", expiresAt: "2026-11-12T00:05:00.000Z", origins: [] };
    const lan = {
      url: "https://my-mac.local:7942",
      fingerprint: "ab cd",
      expiresAt: "2029-02-11T00:00:00.000Z",
    };
    expect([
      PairingCodeResponse.safeParse(reply).success,
      PairingCodeResponse.safeParse({ ...reply, lan }).success,
      PairingCodeResponse.safeParse({ ...reply, lan: { url: lan.url } }).success,
    ]).toEqual([true, true, false]);
  });
});

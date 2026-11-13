import { describe, expect, it, vi } from "vitest";

const compared = vi.hoisted(() => ({ calls: 0 }));
vi.mock("node:crypto", async (original) => {
  const crypto = await original<typeof import("node:crypto")>();
  return {
    ...crypto,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView) => {
      compared.calls++;
      return crypto.timingSafeEqual(a, b);
    },
  };
});

const { PairingCodes } = await import("./pairing.ts");

describe("PairingCodes' comparison", () => {
  it("compares every attempt in constant time, a wrong one and a right one", () => {
    const pairing = new PairingCodes({ log: () => {} });
    const { code } = pairing.issue();
    pairing.attempt("AAAAAAAA", "http://a");
    pairing.attempt(code, "http://a");
    expect(compared.calls).toBe(2);
  });
});

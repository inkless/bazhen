import { X509Certificate, generateKeyPairSync, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LIFETIME_DAYS, fingerprint, selfSigned, toPem } from "./x509.ts";

const now = new Date("2026-11-14T12:00:00.000Z");
const made = (name = "my-mac.local", at = now) => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { der, notAfter } = selfSigned({ name, privateKey, publicKey, now: at });
  return { cert: new X509Certificate(der), der, notAfter, publicKey };
};

describe("a self-signed LAN certificate", () => {
  it("names only the host's .local name, for serving TLS, and can't act as a CA", () => {
    const { cert } = made();
    expect({
      subject: cert.subject,
      san: cert.subjectAltName,
      ca: cert.ca,
      keyUsage: cert.keyUsage,
      selfIssued: cert.checkIssued(cert),
    }).toEqual({
      subject: "CN=my-mac.local",
      san: "DNS:my-mac.local",
      ca: false,
      keyUsage: ["1.3.6.1.5.5.7.3.1"],
      selfIssued: true,
    });
  });

  it("is signed by its own key", () => {
    const { cert, publicKey } = made();
    expect(cert.verify(publicKey)).toBe(true);
    expect(
      cert.verify(createPublicKey(made().cert.publicKey.export({ type: "spki", format: "pem" }))),
    ).toBe(false);
  });

  it("is valid from an hour before now for the lifetime, inside Apple's 825-day limit", () => {
    const { cert, notAfter } = made();
    const from = new Date(cert.validFrom).getTime();
    const to = new Date(cert.validTo).getTime();
    expect(from).toBe(now.getTime() - 60 * 60 * 1000);
    expect((to - from) / 86_400_000).toBe(LIFETIME_DAYS);
    expect(LIFETIME_DAYS).toBeLessThanOrEqual(825);
    expect(notAfter.getTime()).toBe(to);
  });

  it("encodes a date from 2050 on as GeneralizedTime, which still parses", () => {
    const { cert } = made("my-mac.local", new Date("2049-06-01T00:00:00.000Z"));
    expect(new Date(cert.validTo).getUTCFullYear()).toBe(2051);
  });

  it("gets a different serial each time", () => {
    expect(made().cert.serialNumber).not.toBe(made().cert.serialNumber);
  });

  it("round-trips through PEM", () => {
    const { der } = made();
    expect(new X509Certificate(toPem(der)).raw.equals(der)).toBe(true);
  });
});

describe("the fingerprint", () => {
  it("is the certificate's SHA-256 as uppercase hex pairs separated by spaces", () => {
    const { cert, der } = made();
    expect(fingerprint(der)).toBe(cert.fingerprint256.replaceAll(":", " "));
    expect(fingerprint(der)).toMatch(/^([0-9A-F]{2} ){31}[0-9A-F]{2}$/);
  });
});

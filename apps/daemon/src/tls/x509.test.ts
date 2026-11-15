import { X509Certificate, generateKeyPairSync, createPublicKey } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LIFETIME_DAYS, fingerprint, selfSigned, toPem } from "./x509.ts";

const now = new Date("2026-11-14T12:00:00.000Z");
/** The time that makes notAfter `at`: notBefore is an hour back, plus the lifetime. */
const startFor = (at: string) =>
  new Date(Date.parse(at) + 60 * 60 * 1000 - LIFETIME_DAYS * 86_400_000);
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

  it("encodes notAfter as UTCTime through 2049 and GeneralizedTime from 2050", () => {
    const lastUtc = made("my-mac.local", startFor("2049-12-31T23:59:59.000Z")).der;
    const firstGeneralized = made("my-mac.local", startFor("2050-01-01T00:00:00.000Z")).der;
    const utcTime = Buffer.concat([Buffer.from([0x17, 13]), Buffer.from("491231235959Z")]);
    const generalized = Buffer.concat([Buffer.from([0x18, 15]), Buffer.from("20500101000000Z")]);
    expect([lastUtc.includes(utcTime), firstGeneralized.includes(generalized)]).toEqual([
      true,
      true,
    ]);
  });

  it("gets a different serial each time", () => {
    expect(made().cert.serialNumber).not.toBe(made().cert.serialNumber);
  });

  it("encodes a positive serial: a DER integer whose first byte has its top bit clear", () => {
    const serialHeader = Buffer.from([0xa0, 0x03, 0x02, 0x01, 0x02, 0x02, 0x10]);
    const firstBytes = Array.from({ length: 32 }, () => {
      const { der } = made();
      return der.readUInt8(der.indexOf(serialHeader) + serialHeader.length);
    });
    expect(firstBytes.every((b) => b < 0x80)).toBe(true);
  });

  it("round-trips through PEM", () => {
    const { der } = made();
    expect(new X509Certificate(toPem(der)).raw.equals(der)).toBe(true);
  });
});

describe("the fingerprint", () => {
  it("is the certificate's SHA-256 as lowercase hex pairs separated by spaces, as Safari shows it", () => {
    const { cert, der } = made();
    expect(fingerprint(der)).toBe(cert.fingerprint256.replaceAll(":", " ").toLowerCase());
    expect(fingerprint(der)).toMatch(/^([0-9a-f]{2} ){31}[0-9a-f]{2}$/);
  });
});

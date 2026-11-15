import { createHash, randomBytes, sign, type KeyObject } from "node:crypto";

/**
 * Inside Apple's 825-day limit for a TLS server certificate, with room for a clock that runs
 * a little ahead of the iPad's.
 */
export const LIFETIME_DAYS = 820;
const DAY_MS = 24 * 60 * 60 * 1000;
/** notBefore is set back this far, so a device whose clock lags still accepts it at once. */
const BACKDATE_MS = 60 * 60 * 1000;

const OID = {
  ecdsaWithSha256: "1.2.840.10045.4.3.2",
  commonName: "2.5.4.3",
  subjectKeyIdentifier: "2.5.29.14",
  subjectAltName: "2.5.29.17",
  basicConstraints: "2.5.29.19",
  authorityKeyIdentifier: "2.5.29.35",
  extKeyUsage: "2.5.29.37",
  serverAuth: "1.3.6.1.5.5.7.3.1",
};

function length(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const bytes: number[] = [];
  for (let rest = n; rest > 0; rest >>= 8) bytes.unshift(rest & 0xff);
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

const tlv = (tag: number, ...contents: Buffer[]) => {
  const body = Buffer.concat(contents);
  return Buffer.concat([Buffer.from([tag]), length(body.length), body]);
};
const sequence = (...items: Buffer[]) => tlv(0x30, ...items);
const octets = (...items: Buffer[]) => tlv(0x04, ...items);
const TRUE = tlv(0x01, Buffer.from([0xff]));

function oid(dotted: string): Buffer {
  const [first = 0, second = 0, ...rest] = dotted.split(".").map(Number);
  const bytes = [first * 40 + second];
  for (const arc of rest) {
    const groups = [arc & 0x7f];
    for (let v = arc >>> 7; v > 0; v >>>= 7) groups.unshift((v & 0x7f) | 0x80);
    bytes.push(...groups);
  }
  return tlv(0x06, Buffer.from(bytes));
}

/** RFC 5280 §4.1.2.5: UTCTime through 2049, GeneralizedTime from 2050. */
function time(at: Date): Buffer {
  const iso = at.toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const year = at.getUTCFullYear();
  return year < 2050
    ? tlv(0x17, Buffer.from(`${iso.slice(2)}Z`, "ascii"))
    : tlv(0x18, Buffer.from(`${iso}Z`, "ascii"));
}

const extension = (id: string, critical: boolean, value: Buffer) =>
  sequence(oid(id), ...(critical ? [TRUE] : []), octets(value));

/** A positive 128-bit serial: DER integers are signed, so the top bit is cleared. */
function serial(): Buffer {
  const bytes = randomBytes(16);
  bytes[0] = ((bytes[0] ?? 0) & 0x7f) | 0x01;
  return tlv(0x02, bytes);
}

export interface SelfSigned {
  /** The certificate, DER. */
  readonly der: Buffer;
  readonly notAfter: Date;
}

/**
 * A self-signed TLS server certificate for `name` alone. It is `CA:FALSE`, so its key can't
 * sign a certificate any client would accept, whatever else trusts it. It carries no key usage:
 * one without `keyCertSign` makes OpenSSL refuse the certificate as its own issuer, so a client
 * that trusts it directly would still reject it.
 */
export function selfSigned(opts: {
  readonly name: string;
  readonly privateKey: KeyObject;
  readonly publicKey: KeyObject;
  readonly now: Date;
}): SelfSigned {
  const spki = opts.publicKey.export({ type: "spki", format: "der" });
  const keyId = createHash("sha1").update(subjectPublicKey(spki)).digest();
  const notBefore = new Date(opts.now.getTime() - BACKDATE_MS);
  const notAfter = new Date(notBefore.getTime() + LIFETIME_DAYS * DAY_MS);
  const algorithm = sequence(oid(OID.ecdsaWithSha256));
  const subject = sequence(
    tlv(0x31, sequence(oid(OID.commonName), tlv(0x0c, Buffer.from(opts.name, "utf8")))),
  );
  const tbs = sequence(
    tlv(0xa0, tlv(0x02, Buffer.from([2]))),
    serial(),
    algorithm,
    subject,
    sequence(time(notBefore), time(notAfter)),
    subject,
    spki,
    tlv(
      0xa3,
      sequence(
        extension(OID.basicConstraints, true, sequence()),
        extension(OID.extKeyUsage, false, sequence(oid(OID.serverAuth))),
        extension(OID.subjectAltName, false, sequence(tlv(0x82, Buffer.from(opts.name, "ascii")))),
        extension(OID.subjectKeyIdentifier, false, octets(keyId)),
        extension(OID.authorityKeyIdentifier, false, sequence(tlv(0x80, keyId))),
      ),
    ),
  );
  const signature = sign("sha256", tbs, { key: opts.privateKey, dsaEncoding: "der" });
  const der = sequence(tbs, algorithm, tlv(0x03, Buffer.from([0]), signature));
  return { der, notAfter };
}

/** A P-256 SPKI: a fixed 26-byte header, then the uncompressed point 04 ‖ X ‖ Y. */
const P256_SPKI_LENGTH = 91;
const P256_POINT_LENGTH = 65;

/** The point inside the SPKI's BIT STRING: what RFC 5280 §4.2.1.2 hashes for a key identifier. */
function subjectPublicKey(spki: Buffer): Buffer {
  if (spki.length !== P256_SPKI_LENGTH) throw new TypeError("expected a P-256 public key");
  return spki.subarray(P256_SPKI_LENGTH - P256_POINT_LENGTH);
}

export const toPem = (der: Buffer) =>
  `-----BEGIN CERTIFICATE-----\n${der
    .toString("base64")
    .replace(/.{64}/g, "$&\n")
    .trimEnd()}\n-----END CERTIFICATE-----\n`;

/** The certificate's SHA-256 as Safari's certificate details show it. */
export const fingerprint = (der: Buffer) =>
  (createHash("sha256").update(der).digest("hex").toUpperCase().match(/../g) ?? []).join(" ");

import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CERT_FILE,
  KEY_FILE,
  LanCertificateInvalid,
  NoLocalName,
  lanCertificate,
  localName,
} from "./material.ts";

const uid = userInfo().uid;
const name = "my-mac.local";
let root = "";
let dir = "";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bz-lan-cert-"));
  dir = join(root, "tls");
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const mode = (path: string) => statSync(path).mode & 0o777;
const load = (now?: Date) => lanCertificate(dir, { name, uid, ...(now ? { now } : {}) });
const refusal = (now?: Date) => {
  try {
    load(now);
  } catch (err) {
    if (err instanceof LanCertificateInvalid) return { path: err.path, message: err.message };
    throw err;
  }
  throw new Error("expected the certificate to be refused");
};

describe("the LAN certificate on disk", () => {
  it("is made on first start, readable by this user only, with nothing left beside it", () => {
    const made = load();
    expect(made.name).toBe(name);
    expect({
      dir: mode(dir),
      key: mode(join(dir, KEY_FILE)),
      files: readdirSync(dir).toSorted(),
    }).toEqual({ dir: 0o700, key: 0o600, files: [CERT_FILE, KEY_FILE] });
  });

  it("is kept from one start to the next, so its fingerprint doesn't change", () => {
    const first = load();
    expect(load().fingerprint).toBe(first.fingerprint);
  });

  it("is made again when its key was written but its certificate wasn't", () => {
    const first = load();
    unlinkSync(join(dir, CERT_FILE));
    const again = load();
    expect(again.fingerprint).not.toBe(first.fingerprint);
    expect(readdirSync(dir).toSorted()).toEqual([CERT_FILE, KEY_FILE]);
  });

  it("refuses a certificate whose key is gone, naming the recovery", () => {
    load();
    unlinkSync(join(dir, KEY_FILE));
    const refused = refusal();
    expect(refused.path).toBe(join(dir, KEY_FILE));
    expect(refused.message).toContain(`delete ${dir} and restart`);
  });

  it("refuses a key other users can read", () => {
    load();
    chmodSync(join(dir, KEY_FILE), 0o640);
    expect(refusal().path).toBe(join(dir, KEY_FILE));
  });

  it("refuses a key that is a symlink", () => {
    load();
    const elsewhere = join(root, "elsewhere");
    writeFileSync(elsewhere, "", { mode: 0o600 });
    unlinkSync(join(dir, KEY_FILE));
    symlinkSync(elsewhere, join(dir, KEY_FILE));
    expect(refusal().message).toContain(`${join(dir, KEY_FILE)} is not a regular file`);
  });

  it("refuses a corrupt certificate rather than replacing it", () => {
    load();
    writeFileSync(join(dir, CERT_FILE), "not a certificate");
    expect(refusal().path).toBe(join(dir, CERT_FILE));
  });

  it("refuses a corrupt key", () => {
    load();
    writeFileSync(join(dir, KEY_FILE), "not a key", { mode: 0o600 });
    expect(refusal().path).toBe(join(dir, KEY_FILE));
  });

  it("refuses a key that doesn't match its certificate", () => {
    load();
    const other = join(root, "other");
    lanCertificate(other, { name, uid });
    writeFileSync(join(dir, KEY_FILE), readFileSync(join(other, KEY_FILE)), { mode: 0o600 });
    expect(refusal().message).toContain("doesn't match");
  });

  it("refuses an expired certificate", () => {
    const made = load();
    expect(refusal(new Date(made.notAfter.getTime() + 1)).message).toContain("expired");
  });
});

describe("the host's .local name", () => {
  it("is macOS's Bonjour name there, lower-cased", () => {
    expect(localName("darwin", () => "Gz-MacBook\n")).toBe("gz-macbook.local");
  });

  it("refuses a name that can't be one, and says so when it can't be read", () => {
    expect(() => localName("darwin", () => "my mac")).toThrow(NoLocalName);
    expect(() =>
      localName("darwin", () => {
        throw new Error("scutil: not found");
      }),
    ).toThrow(NoLocalName);
  });
});

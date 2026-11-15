import {
  chmodSync,
  mkdirSync,
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
import { format, inspect } from "node:util";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CERT_FILE,
  KEY_FILE,
  LanCertificateInvalid,
  NoLocalName,
  lanCertificate,
  localName,
  writeAll,
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
const refusal = (now?: Date, suffix?: () => string) => {
  try {
    lanCertificate(dir, { name, uid, ...(now ? { now } : {}), ...(suffix ? { suffix } : {}) });
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

  it("leaves its key out when it is logged or serialised", () => {
    const made = load();
    const shown = [JSON.stringify(made), inspect(made), format("%o", made)];
    expect([
      made.key.includes("PRIVATE KEY"),
      shown.some((t) => t.includes("PRIVATE KEY")),
    ]).toEqual([true, false]);
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
    expect(refusal().message).toContain(`${join(dir, KEY_FILE)} is a symlink`);
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
    expect(refusal().message).toContain(
      `is not the key of the certificate ${join(dir, CERT_FILE)}`,
    );
  });

  it("refuses an expired certificate", () => {
    const made = load();
    expect(refusal(new Date(made.notAfter.getTime() + 1)).message).toContain("expired");
  });
});

describe("writing the certificate", () => {
  const SUFFIX = "0123456789ab";
  const temporary = () => join(dir, `.${KEY_FILE}.${SUFFIX}`);

  it("refuses a certificate that is a symlink", () => {
    load();
    const copy = join(root, "copy.crt");
    writeFileSync(copy, readFileSync(join(dir, CERT_FILE)));
    unlinkSync(join(dir, CERT_FILE));
    symlinkSync(copy, join(dir, CERT_FILE));
    expect(refusal().message).toContain(`${join(dir, CERT_FILE)} is a symlink`);
  });

  it("removes what an interrupted write left, on the next start", () => {
    load();
    const stale = join(dir, `.${KEY_FILE}.${SUFFIX}`);
    writeFileSync(stale, "half a key", { mode: 0o600 });
    load();
    expect(readdirSync(dir).toSorted()).toEqual([CERT_FILE, KEY_FILE]);
  });

  it("names what an interrupted write left, and why, when it can't remove it", () => {
    load();
    const left = join(dir, `.${KEY_FILE}.${SUFFIX}`);
    mkdirSync(left);
    const refused = refusal();
    expect([
      refused.path,
      refused.message.includes("couldn't be removed"),
      refused.message.includes("EISDIR"),
    ]).toEqual([left, true, true]);
  });

  it("won't write the key into a file someone put at its temporary name", () => {
    const planted = () => {
      writeFileSync(temporary(), "planted", { mode: 0o644 });
      return SUFFIX;
    };
    const refused = refusal(undefined, planted);
    expect([refused.message, readFileSync(temporary(), "utf8")]).toEqual([
      expect.stringContaining("couldn't be written: EEXIST"),
      "planted",
    ]);
  });

  it("won't follow a symlink someone put at its temporary name", () => {
    const outside = join(root, "outside");
    const planted = () => {
      symlinkSync(outside, temporary());
      return SUFFIX;
    };
    refusal(undefined, planted);
    expect(readdirSync(root).includes("outside")).toBe(false);
  });

  it("removes its temporary file when the write after it fails", () => {
    mkdirSync(join(dir, KEY_FILE), { recursive: true });
    const refused = refusal();
    expect([refused.message, readdirSync(dir).filter((f) => f.startsWith("."))]).toEqual([
      expect.stringContaining("Fix that and restart"),
      [],
    ]);
  });

  it("names the real error, and doesn't send the user to delete anything, when it can't write", () => {
    writeFileSync(join(root, "file"), "");
    dir = join(root, "file", "tls");
    const refused = refusal();
    expect([
      refused.message.includes("Fix that and restart"),
      refused.message.includes("ENOTDIR"),
      refused.message.includes("delete"),
    ]).toEqual([true, true, false]);
  });

  it("writes everything however few bytes each write takes, and fails on a write that takes none", () => {
    const out: number[] = [];
    writeAll((buffer, offset) => {
      const chunk = buffer.subarray(offset, offset + 3);
      out.push(...chunk);
      return chunk.length;
    }, Buffer.from("0123456789"));
    expect(Buffer.from(out).toString()).toBe("0123456789");
    expect(() => writeAll(() => 0, Buffer.from("x"))).toThrow("a write stopped after 0 of 1 bytes");
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

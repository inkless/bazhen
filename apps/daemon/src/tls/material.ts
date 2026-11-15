import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeSync,
  type Stats,
} from "node:fs";
import { X509Certificate, createPrivateKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { inspect } from "node:util";
import { ensurePrivateDir } from "../config/private-dir.ts";
import { fingerprint, selfSigned, toPem } from "./x509.ts";

export const KEY_FILE = "lan.key";
export const CERT_FILE = "lan.crt";
/** What an interrupted write leaves: `.lan.key.<12 hex>` or `.lan.crt.<12 hex>`. */
const TEMPORARY = /^\.lan\.(key|crt)\.[0-9a-f]{12}$/;

/**
 * The LAN certificate can't be used as it is. A bad certificate is never replaced on its own: the
 * browser trusts this fingerprint, and a new one would change it behind the owner's back.
 */
export class LanCertificateInvalid extends Error {
  override readonly name = "LanCertificateInvalid";
  readonly path: string;

  constructor(path: string, problem: string, recovery: string, options?: ErrorOptions) {
    super(`the LAN certificate can't be used: ${path} ${problem}. ${recovery}`, options);
    this.path = path;
  }
}

export interface LanCertificate {
  /** The private key, PEM: left out when the object is logged or serialised. */
  readonly key: string;
  readonly cert: string;
  /** The one name it serves, from the certificate itself. */
  readonly name: string;
  readonly fingerprint: string;
  readonly notAfter: Date;
  readonly path: string;
  toJSON(): Record<string, unknown>;
  [inspect.custom](): Record<string, unknown>;
}

/** Everything but the key, for whatever logs or serialises the certificate. */
const redacted = (c: LanCertificate) => ({
  key: "[redacted]",
  cert: c.cert,
  name: c.name,
  fingerprint: c.fingerprint,
  notAfter: c.notAfter,
  path: c.path,
});

/** An error's message and its causes', so the errno a wrapper hides is still named. */
function errorText(err: unknown): string {
  const parts: string[] = [];
  for (let at: unknown = err; at instanceof Error && parts.length < 5; at = at.cause) {
    parts.push(at.message);
  }
  return parts.length === 0 ? "an unknown error" : parts.join(": ");
}
/** A failure that isn't the certificate's: the directory or a file couldn't be made or read. */
const failed = (path: string, doing: string, cause: unknown) =>
  new LanCertificateInvalid(path, `${doing}: ${errorText(cause)}`, "Fix that and restart", {
    cause,
  });
const codeOf = (err: unknown) =>
  err instanceof Error && "code" in err && typeof err.code === "string" ? err.code : undefined;

/**
 * The LAN listener's certificate in `dir`, made for `name` if there is none. A key without its
 * certificate is an interrupted first start, since the certificate is written last. `suffix`
 * names temporary files; it is only for tests.
 */
export function lanCertificate(
  dir: string,
  opts: {
    readonly name: string;
    readonly uid: number;
    readonly now?: Date;
    readonly suffix?: () => string;
  },
): LanCertificate {
  const now = opts.now ?? new Date();
  const suffix = opts.suffix ?? (() => randomBytes(6).toString("hex"));
  const keyPath = join(dir, KEY_FILE);
  const certPath = join(dir, CERT_FILE);
  const remake = `To make a new one, delete ${dir} and restart; then trust its new fingerprint on each device`;
  const unusable = (path: string, problem: string, cause?: unknown) =>
    new LanCertificateInvalid(path, problem, remake, cause === undefined ? undefined : { cause });

  let entries: string[];
  try {
    ensurePrivateDir(dir, opts.uid);
    entries = readdirSync(dir);
  } catch (err) {
    throw failed(dir, "couldn't be made private", err);
  }
  for (const entry of entries.filter((e) => TEMPORARY.test(e))) {
    const left = join(dir, entry);
    try {
      rmSync(left, { force: true });
    } catch (err) {
      throw failed(left, "is left from an interrupted write, and couldn't be removed", err);
    }
  }
  let certFound: boolean;
  try {
    certFound = lstatSync(certPath, { throwIfNoEntry: false }) !== undefined;
  } catch (err) {
    throw failed(certPath, "couldn't be read", err);
  }
  if (!certFound) {
    try {
      create(dir, opts.name, now, suffix);
    } catch (err) {
      throw failed(dir, "couldn't be written", err);
    }
  }

  /** A file read through one descriptor, so what was checked is what is read. */
  const read = (path: string, missing: string, check: (stat: Stats) => string | null): string => {
    let fd: number;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    } catch (err) {
      if (codeOf(err) === "ELOOP") throw unusable(path, "is a symlink");
      if (codeOf(err) === "ENOENT") throw unusable(path, missing);
      throw failed(path, "couldn't be read", err);
    }
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile()) throw unusable(path, "is not a regular file");
      const problem = check(stat);
      if (problem !== null) throw unusable(path, problem);
      return readFileSync(fd, "utf8");
    } finally {
      closeSync(fd);
    }
  };
  const key = read(keyPath, "is missing, though its certificate is there", (stat) => {
    if (stat.uid !== opts.uid) return `is owned by uid ${stat.uid}`;
    return (stat.mode & 0o077) === 0 ? null : "can be read by other users";
  });
  const pem = read(certPath, "went missing as it was read", () => null);

  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch (err) {
    throw unusable(certPath, "is not a certificate", err);
  }
  let matches: boolean;
  try {
    matches = cert.checkPrivateKey(createPrivateKey(key));
  } catch (err) {
    throw unusable(keyPath, "is not a private key", err);
  }
  if (!matches) throw unusable(keyPath, `is not the key of the certificate ${certPath}`);
  const name = /^DNS:([^,]+)$/.exec(cert.subjectAltName ?? "")?.[1];
  if (name === undefined) throw unusable(certPath, "doesn't name a single host");
  const notAfter = new Date(cert.validTo);
  if (notAfter <= now) throw unusable(certPath, `expired on ${notAfter.toISOString()}`);
  const loaded: LanCertificate = {
    key,
    cert: pem,
    name,
    fingerprint: fingerprint(cert.raw),
    notAfter,
    path: certPath,
    toJSON: () => redacted(loaded),
    [inspect.custom]: () => redacted(loaded),
  };
  return loaded;
}

function create(dir: string, name: string, now: Date, suffix: () => string): void {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { der } = selfSigned({ name, privateKey, publicKey, now });
  writeNew(dir, KEY_FILE, privateKey.export({ type: "pkcs8", format: "pem" }), suffix());
  writeNew(dir, CERT_FILE, toPem(der), suffix());
}

/**
 * Writes a file whole or not at all, 0600 from the moment it exists. The temporary name must not
 * exist yet (`O_EXCL`, which also refuses a symlink there), and is removed if anything after its
 * creation fails; then it is synced, renamed over the target, and the directory synced.
 */
function writeNew(dir: string, file: string, data: string, suffix: string): void {
  const temporary = join(dir, `.${file}.${suffix}`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const fd = openSync(temporary, flags, 0o600);
  try {
    try {
      writeAll((buffer, offset) => writeSync(fd, buffer, offset), Buffer.from(data, "utf8"));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporary, join(dir, file));
  } catch (err) {
    rmSync(temporary, { force: true });
    throw err;
  }
  const dirFd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
  }
}

/** Writes all of `buffer`, however few bytes each write takes; a write that takes none fails. */
export function writeAll(write: (buffer: Buffer, offset: number) => number, buffer: Buffer): void {
  for (let offset = 0; offset < buffer.length;) {
    const written = write(buffer, offset);
    if (written <= 0) throw new Error(`a write stopped after ${offset} of ${buffer.length} bytes`);
    offset += written;
  }
}

/** This host's `.local` name couldn't be read. */
export class NoLocalName extends Error {
  override readonly name = "NoLocalName";
}

/**
 * The name a device on the LAN finds this host by. macOS keeps its Bonjour name apart from the
 * hostname; elsewhere it is the hostname, which avahi publishes.
 */
export function localName(
  platform: NodeJS.Platform = process.platform,
  run: (command: string, args: string[]) => string = (command, args) =>
    execFileSync(command, args, { encoding: "utf8" }),
): string {
  let base: string;
  try {
    base = platform === "darwin" ? run("scutil", ["--get", "LocalHostName"]) : hostname();
  } catch (cause) {
    throw new NoLocalName("this host's .local name couldn't be read (scutil --get LocalHostName)", {
      cause,
    });
  }
  const label = base.trim().split(".")[0]?.toLowerCase() ?? "";
  if (!/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) {
    throw new NoLocalName(`this host's name, ${JSON.stringify(base.trim())}, isn't a .local name`);
  }
  return `${label}.local`;
}

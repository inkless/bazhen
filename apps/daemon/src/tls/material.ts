import {
  closeSync,
  constants,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from "node:fs";
import { X509Certificate, createPrivateKey, generateKeyPairSync, randomBytes } from "node:crypto";
import { join } from "node:path";
import { hostname } from "node:os";
import { execFileSync } from "node:child_process";
import { ensurePrivateDir } from "../config/private-dir.ts";
import { fingerprint, selfSigned, toPem } from "./x509.ts";

export const KEY_FILE = "lan.key";
export const CERT_FILE = "lan.crt";

/**
 * The LAN certificate can't be used as it is. It is never replaced on its own: the iPad trusts
 * this fingerprint, and a new one would change it behind the owner's back.
 */
export class LanCertificateInvalid extends Error {
  override readonly name = "LanCertificateInvalid";
  readonly path: string;

  constructor(path: string, reason: string, dir: string, options?: ErrorOptions) {
    super(
      `the LAN certificate can't be used: ${path} ${reason}. ` +
        `To make a new one, delete ${dir} and restart; then trust its new fingerprint on each device`,
      options,
    );
    this.path = path;
  }
}

export interface LanCertificate {
  readonly key: string;
  readonly cert: string;
  /** The one name it serves, from the certificate itself. */
  readonly name: string;
  readonly fingerprint: string;
  readonly notAfter: Date;
  readonly path: string;
}

/**
 * The LAN listener's certificate in `dir`, made for `name` if there is none. A key without its
 * certificate is an interrupted first start, since the certificate is written last.
 */
export function lanCertificate(
  dir: string,
  opts: { readonly name: string; readonly uid: number; readonly now?: Date },
): LanCertificate {
  const now = opts.now ?? new Date();
  const keyPath = join(dir, KEY_FILE);
  const certPath = join(dir, CERT_FILE);
  const invalid = (path: string, reason: string, cause?: unknown) =>
    new LanCertificateInvalid(path, reason, dir, cause === undefined ? undefined : { cause });
  try {
    ensurePrivateDir(dir, opts.uid);
    if (!present(certPath)) create(dir, opts.name, now);
  } catch (err) {
    throw invalid(dir, "could not be made private and written", err);
  }

  const keyStat = lstatSync(keyPath, { throwIfNoEntry: false });
  if (keyStat === undefined) throw invalid(keyPath, "is missing, though its certificate is there");
  if (!keyStat.isFile()) throw invalid(keyPath, "is not a regular file");
  if (keyStat.uid !== opts.uid) throw invalid(keyPath, `is owned by uid ${keyStat.uid}`);
  if ((keyStat.mode & 0o077) !== 0) throw invalid(keyPath, "can be read by other users");
  if (!lstatSync(certPath).isFile()) throw invalid(certPath, "is not a regular file");

  const key = readFileSync(keyPath, "utf8");
  const pem = readFileSync(certPath, "utf8");
  let cert: X509Certificate;
  try {
    cert = new X509Certificate(pem);
  } catch (err) {
    throw invalid(certPath, "is not a certificate", err);
  }
  try {
    if (!cert.checkPrivateKey(createPrivateKey(key))) throw invalid(keyPath, "doesn't match it");
  } catch (err) {
    if (err instanceof LanCertificateInvalid) throw err;
    throw invalid(keyPath, "is not a private key", err);
  }
  const name = /^DNS:([^,]+)$/.exec(cert.subjectAltName ?? "")?.[1];
  if (name === undefined) throw invalid(certPath, "doesn't name a single host");
  const notAfter = new Date(cert.validTo);
  if (notAfter <= now) throw invalid(certPath, `expired on ${notAfter.toISOString()}`);
  return { key, cert: pem, name, fingerprint: fingerprint(cert.raw), notAfter, path: certPath };
}

const present = (path: string) => lstatSync(path, { throwIfNoEntry: false }) !== undefined;

function create(dir: string, name: string, now: Date): void {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const { der } = selfSigned({ name, privateKey, publicKey, now });
  writeNew(dir, KEY_FILE, privateKey.export({ type: "pkcs8", format: "pem" }));
  writeNew(dir, CERT_FILE, toPem(der));
}

/**
 * Writes a file whole or not at all, 0600 from the moment it exists: a fresh temporary name that
 * a symlink can't stand in for, synced, renamed over the target, then the directory synced.
 */
function writeNew(dir: string, file: string, data: string): void {
  const temporary = join(dir, `.${file}.${randomBytes(6).toString("hex")}`);
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
  const fd = openSync(temporary, flags, 0o600);
  try {
    writeSync(fd, data);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temporary, join(dir, file));
  const dirFd = openSync(dir, constants.O_RDONLY);
  try {
    fsyncSync(dirFd);
  } finally {
    closeSync(dirFd);
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

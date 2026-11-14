import { chmodSync, lstatSync, mkdirSync } from "node:fs";

export class UnsafePrivateDir extends Error {
  readonly path: string;

  constructor(path: string, reason: string, options?: ErrorOptions) {
    super(`refusing to use ${path} as a private directory: ${reason}`, options);
    this.path = path;
  }
}

/**
 * Creates a directory, or tightens an existing one, so that only this user can reach what is in
 * it: the daemon's socket (foundation-design §6.1, §9.1), or the link every hook runs. Anything this user doesn't own, or a
 * symlink that could redirect the socket, is refused rather than repaired.
 */
export function ensurePrivateDir(path: string, uid: number): void {
  try {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  } catch (cause) {
    throw new UnsafePrivateDir(path, "it cannot be created", { cause });
  }
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) throw new UnsafePrivateDir(path, "it is a symlink");
  if (stat.uid !== uid) throw new UnsafePrivateDir(path, `it is owned by uid ${stat.uid}`);
  if ((stat.mode & 0o777) !== 0o700) chmodSync(path, 0o700);
}

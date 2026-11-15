import { lstatSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../config/private-dir.ts";

/** A snippet isn't as it was written, so no shell is pointed at it. */
export class UnsafeSnippet extends Error {
  constructor(path: string, reason: string) {
    super(`refusing to point shells at ${path}: ${reason}`);
  }
}

/** The shells an integration snippet is written for, each in a file named after it. */
export const INTEGRATED_SHELLS = ["zsh", "bash", "fish"] as const;

const snippet = (shell: string) =>
  readFileSync(new URL(`./integration/${shell}`, import.meta.url), "utf8");

/**
 * Writes the snippets shells source from their rc files into `dir`, and returns `dir`. Whatever
 * a snippet says, every shell runs as it starts, so only this user may write one: the directory
 * is 0700 and each file 0600, both this user's. A file is written whole under another name and
 * renamed into place, so a shell starting meanwhile sources the old one or the new, never half.
 * Anything there that isn't as written is refused, not repaired.
 */
export function installShellIntegration(dir: string, uid: number): string {
  ensurePrivateDir(dir, uid);
  for (const shell of INTEGRATED_SHELLS) {
    const path = join(dir, shell);
    const next = `${path}.tmp`;
    rmSync(next, { force: true });
    writeFileSync(next, snippet(shell), { mode: 0o600, flag: "wx" });
    renameSync(next, path);
    const stat = lstatSync(path);
    if (!stat.isFile()) throw new UnsafeSnippet(path, "it isn't a regular file");
    if (stat.uid !== uid) throw new UnsafeSnippet(path, `it is owned by uid ${stat.uid}`);
    if ((stat.mode & 0o777) !== 0o600)
      throw new UnsafeSnippet(path, `its mode is ${(stat.mode & 0o777).toString(8)}`);
  }
  return dir;
}

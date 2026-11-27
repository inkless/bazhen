// Installs the built `bazhen-holder` where the daemon runs it from: a directory named by the
// binary's content, which nothing writes again once it is there. A holder runs for as long as its
// terminal does, so the next build installs beside it, never over it, and the old directory goes
// only once no process runs it.

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  utimes,
} from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { HOLDER_BUILD, HOLDER_COMMAND, heard, holderBuildOf } from "@bazhen/host-guard";

const TEMP = /^\.tmp-[0-9a-f]{8}$/;
const BAD = /^\.bad-[0-9a-f]{16}-[0-9a-f]{8}$/;
/**
 * How old a directory must be before a prune may remove it: younger, it may be another start's
 * install, still copying, or a build it has just installed and not yet started a holder from.
 */
export const FRESH_MS = 10 * 60_000;
/**
 * `ps` prints a path as it is only in printable ASCII less the backslash: in the C locale, other
 * bytes come out as `?` or escaped, and BSD's `ps` doubles a backslash, so no holder under such a
 * directory would be found running.
 */
const PRINTABLE = /^[\x20-\x5b\x5d-\x7e]+$/;
const PS_MAX_BYTES = 16 << 20;
const PS_TIMEOUT_MS = 5_000;
const PS_ENV = { LC_ALL: "C", PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

export interface InstalledHolder {
  /** What new holders run. */
  readonly binary: string;
  readonly build: string;
  /** The directory every build is installed in. */
  readonly installDir: string;
}

/** The build new holders run, or why there is none. */
export type HolderInstall =
  | { readonly installed: InstalledHolder }
  | { readonly installed: null; readonly reason: string };

export interface InstallOptions {
  /** The built binary. */
  readonly source: string;
  /** What the installed binary is named in its build's directory; the holder's by default. */
  readonly command?: string;
  /** Where builds are installed, each in a directory of its own. */
  readonly dir: string;
  readonly uid: number;
}

/** What `installHolder` lets its tests do between its steps. */
export interface InstallSeams {
  /** Called once the copy is made, before it is hashed. */
  readonly afterCopy?: () => Promise<void>;
  /** Called just before the finished copy is renamed into place. */
  readonly beforeRename?: () => Promise<void>;
}

const tag = () => randomBytes(4).toString("hex");
const codeOf = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined;
const lstatOrNull = (path: string) => lstat(path).catch(() => null);
const writableByOthers = (mode: number) => (mode & 0o022) !== 0;

async function buildOf(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Why `dir` can't hold holder builds, or undefined when it can. It is made if missing, and never
 * repaired: whoever else can write it would choose what every new holder runs. Its ancestors are
 * not checked: they are the user's state directory and above, which the daemon trusts as it does
 * for its database.
 */
async function dirRefusal(dir: string, uid: number): Promise<string | undefined> {
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
  } catch (error) {
    return `it can't be made: ${String(error)}`;
  }
  const stat = await lstat(dir);
  if (stat.isSymbolicLink()) return "it is a symlink";
  if (!stat.isDirectory()) return "it isn't a directory";
  if (stat.uid !== uid) return `it belongs to uid ${stat.uid}`;
  if (writableByOthers(stat.mode)) return "other users may write it";
  return undefined;
}

/** Whether `path` holds `build` as installed: this user's, writable by no one else, its hash. */
async function holds(path: string, build: string, uid: number, command: string): Promise<boolean> {
  const dir = await lstatOrNull(path);
  if (dir === null || !dir.isDirectory() || dir.uid !== uid || writableByOthers(dir.mode)) {
    return false;
  }
  const binary = join(path, command);
  const file = await lstatOrNull(binary);
  if (file === null || !file.isFile() || file.uid !== uid || writableByOthers(file.mode)) {
    return false;
  }
  return (await buildOf(binary)) === build;
}

async function synced(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Installs `source` in `dir`, under its build, unless it already is. The copy is made in a
 * temporary directory and renamed into place, so no holder finds it half written; the build is
 * the copy's hash, not the source's, which a build running meanwhile could change. Something else
 * under the build's name is moved aside, never written over: a holder may run it, and macOS
 * kills a signed binary changed under it.
 */
export async function installHolder(
  { source, dir, uid, command = HOLDER_COMMAND }: InstallOptions,
  seams: InstallSeams = {},
): Promise<HolderInstall> {
  const built = await lstatOrNull(source);
  if (built === null)
    return { installed: null, reason: `${source} isn't built; run \`make build\`` };
  const refusal = await dirRefusal(dir, uid);
  if (refusal !== undefined) {
    return { installed: null, reason: `refusing ${dir} for ${command} builds: ${refusal}` };
  }
  const temp = join(dir, `.tmp-${tag()}`);
  try {
    await mkdir(temp, { mode: 0o700 });
    const copy = join(temp, command);
    await copyFile(source, copy);
    await chmod(copy, 0o500);
    await synced(copy);
    await seams.afterCopy?.();
    const build = await buildOf(copy);
    const target = join(dir, build);
    const installed = { binary: join(dir, build, command), build, installDir: dir };
    // Read once, before the check: an install that renames its copy in meanwhile is whole.
    if ((await lstatOrNull(target)) !== null) {
      if (await holds(target, build, uid, command)) {
        // Fresh again, so a prune by another start that installed some other build leaves it.
        const now = new Date();
        await utimes(target, now, now);
        return { installed };
      }
      await rename(target, join(dir, `.bad-${build}-${tag()}`)).catch((error: unknown) => {
        if (codeOf(error) !== "ENOENT") throw error;
      });
    }
    await seams.beforeRename?.();
    try {
      await rename(temp, target);
    } catch (error) {
      // Another install of the same build got there first.
      const lost = codeOf(error) === "ENOTEMPTY" || codeOf(error) === "EEXIST";
      if (!(lost && (await holds(target, build, uid, command)))) throw error;
    }
    // Best effort: the rename stands either way, and some filesystems can't sync a directory.
    await synced(dir).catch(() => {});
    return { installed };
  } catch (error) {
    return { installed: null, reason: `${command} couldn't be installed: ${String(error)}` };
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

/**
 * Removes from `dir` every build not in `keep`, what installs moved aside, and the temporary
 * directories of installs that stopped, by name, and builds and temporary directories only once
 * older than `FRESH_MS`. Nothing else there is touched, and no link is followed: what was moved
 * aside may be a link, which is unlinked. What it removed, by name.
 */
export async function pruneHolderBuilds(
  dir: string,
  uid: number,
  keep: ReadonlySet<string>,
  now = Date.now(),
): Promise<string[]> {
  if ((await dirRefusal(dir, uid)) !== undefined) return [];
  const removed: string[] = [];
  for (const name of await readdir(dir)) {
    const path = join(dir, name);
    const stat = await lstatOrNull(path);
    if (stat === null) continue;
    const old = now - stat.mtimeMs > FRESH_MS;
    const directory = stat.isDirectory();
    const unused =
      BAD.test(name) ||
      (directory && old && (HOLDER_BUILD.test(name) ? !keep.has(name) : TEMP.test(name)));
    if (!unused) continue;
    try {
      await rm(path, { recursive: directory });
      removed.push(name);
    } catch {
      // Left for the next start.
    }
  }
  return removed;
}

/** Every process's pid, owner and args, as `ps -A -o pid=,uid=,args=` prints them. */
export type ProcessArgs = () => Promise<string>;

const psArgs: ProcessArgs = async () => {
  const run = promisify(execFile);
  const ps = ["-A", "-ww", "-o", "pid=,uid=,args="];
  return (
    await heard(run("ps", ps, { env: PS_ENV, timeout: PS_TIMEOUT_MS, maxBuffer: PS_MAX_BYTES }))
  ).stdout;
};

/**
 * The builds in `dir` that some process of `uid` runs, whatever its socket shows; null when `ps`
 * can't vouch for having listed them all, so that nothing is taken for unused: it failed, it
 * didn't list `self`, this process, as `uid`'s, as a `ps` that lists only some processes
 * wouldn't, or `dir` isn't a path it prints as it is.
 */
export async function runningBuilds(
  dir: string,
  uid: number,
  ps: ProcessArgs = psArgs,
  self = process.pid,
): Promise<Set<string> | null> {
  if (!PRINTABLE.test(dir)) return null;
  let out: string;
  try {
    out = await ps();
  } catch {
    return null;
  }
  const builds = new Set<string>();
  let listedSelf = false;
  for (const line of out.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match === null || Number(match[2]) !== uid) continue;
    if (Number(match[1]) === self) listedSelf = true;
    const build = holderBuildOf(match[3] ?? "", dir);
    if (build !== null) builds.add(build);
  }
  return listedSelf ? builds : null;
}

/**
 * Removes the builds in `dir` that neither `install` nor any running process uses: none when
 * `ps` can't say what runs.
 */
export async function pruneUnusedHolders(
  dir: string,
  uid: number,
  install: HolderInstall,
  ps?: ProcessArgs,
  self?: number,
): Promise<string[]> {
  const keep = await runningBuilds(dir, uid, ps, self);
  if (keep === null) return [];
  if (install.installed !== null) keep.add(install.installed.build);
  return pruneHolderBuilds(dir, uid, keep);
}

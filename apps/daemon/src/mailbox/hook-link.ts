import { readlinkSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { type HolderInstall, installHolder, pruneHolderBuilds } from "@bazhen/runtime-holder";
import { ensurePrivateDir } from "../config/private-dir.ts";

const HOOK_COMMAND = "bazhen-hook";

/**
 * A path in `dir` that runs `client`, for hooks that outlive this daemon: a tmux server and
 * running agents keep the path they were given, and each start points it at wherever the client
 * now is. The new link is renamed over the old one, so a hook running meanwhile never finds the
 * path missing. `dir` must be private to `uid`, since whoever can write it chooses what every hook
 * runs. Where it can't be made, `client` itself, said through `warn`.
 */
export function stableHookClient(
  dir: string,
  client: string,
  uid: number,
  warn: (message: string) => void = console.warn,
): string {
  const link = join(dir, HOOK_COMMAND);
  const next = `${link}.tmp`;
  try {
    ensurePrivateDir(dir, uid);
    rmSync(next, { force: true });
    symlinkSync(client, next);
    renameSync(next, link);
    return link;
  } catch (err) {
    warn(`hooks run ${client} by its own path, which a move breaks: ${String(err)}`);
    return client;
  }
}

/** The build in `dir` that `link` points at, or "" when it points at none. */
function linkedBuild(link: string, dir: string): string {
  let target: string;
  try {
    target = readlinkSync(link);
  } catch {
    return "";
  }
  return dirname(dirname(target)) === dir && basename(target) === HOOK_COMMAND
    ? basename(dirname(target))
    : "";
}

export interface HookClient {
  /** What hooks are given to run. */
  readonly path: string;
  /** The file `path` runs. */
  readonly client: string;
}

/**
 * Installs `source` in `dir` under its content's hash and points the link at that copy, which no
 * rebuild or move of the checkout touches. Once the link is made, hooks reach a build only through
 * it, so the builds it no longer names are removed. Where no link can be made, hooks are given the
 * copy by its own path, which a later start can't tell is in use, so nothing is removed.
 */
export async function installHookClient({
  source,
  dir,
  uid,
  warn = console.warn,
  beforePrune,
}: {
  source: string;
  dir: string;
  uid: number;
  warn?: (message: string) => void;
  /** Called once the link is made, before the builds it doesn't name are removed; for tests. */
  beforePrune?: () => void;
}): Promise<HookClient> {
  let install: HolderInstall;
  try {
    // Tightened first: the install refuses a directory others may write, and never repairs one.
    ensurePrivateDir(dir, uid);
    install = await installHolder({ source, dir, uid, command: HOOK_COMMAND });
  } catch (err) {
    install = { installed: null, reason: String(err) };
  }
  if (install.installed === null) warn(`hooks run ${source} from the checkout: ${install.reason}`);
  const client = install.installed?.binary ?? source;
  const path = stableHookClient(dir, client, uid, warn);
  if (install.installed !== null && path !== client) {
    beforePrune?.();
    // Another start on this state may have pointed the link at its own build since.
    const keep = new Set([install.installed.build, linkedBuild(path, dir)]);
    await pruneHolderBuilds(dir, uid, keep).catch((err: unknown) =>
      warn(`hook client builds weren't pruned: ${String(err)}`),
    );
  }
  return { path, client };
}

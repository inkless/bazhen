import { renameSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir } from "../config/private-dir.ts";

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
  const link = join(dir, "bazhen-hook");
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

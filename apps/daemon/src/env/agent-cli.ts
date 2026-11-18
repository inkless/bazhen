import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Where `pnpm build` leaves the CLI, beside the daemon that runs from this checkout. */
const BUILT = fileURLToPath(new URL("../../../../target/release/bazhen", import.meta.url));

export interface AgentCli {
  /** The CLI built beside the daemon, as a resolved path; null when none is built. */
  readonly expected: string | null;
  /** The first `bazhen` on the PATH, as a resolved path; null when there is none. */
  readonly onPath: string | null;
}

/** `file` as a shell would run it, resolved through links; null for anything it would skip. */
function runnable(file: string): string | null {
  try {
    if (!statSync(file).isFile()) return null;
    accessSync(file, constants.X_OK);
    return realpathSync(file);
  } catch {
    return null;
  }
}

/**
 * The `bazhen` an agent started with `env` runs, beside the one built with this daemon: a
 * different one is another build, which the agent's commands can't be sure to speak the daemon's
 * protocol with. Resolved, so a link to the build is the build and a copy is not. A relative PATH
 * entry means the agent's own directory, which isn't known here, so it is skipped.
 */
export function agentCli(
  env: Readonly<Record<string, string | undefined>>,
  built: string = BUILT,
): AgentCli {
  const onPath = (env["PATH"] ?? "")
    .split(delimiter)
    .filter(isAbsolute)
    .map((dir) => runnable(join(dir, "bazhen")))
    .find((found) => found !== null);
  return { expected: runnable(built), onPath: onPath ?? null };
}

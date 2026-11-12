import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

export class InvalidDirectory extends Error {}

/**
 * The directory a launch asked for, as the daemon will use it. A leading `~` is the daemon
 * user's home, as a shell would read it, so a path typed or pasted from a terminal works. Anything
 * else must be absolute, and an existing directory.
 */
export function resolveDirectory(requested: string, home: string): string {
  const path =
    requested === "~"
      ? home
      : requested.startsWith("~/")
        ? join(home, requested.slice(2))
        : requested;
  if (!isAbsolute(path)) {
    throw new InvalidDirectory(`"${requested}" is not a full path: start it with / or ~/`);
  }
  let isDirectory: boolean;
  try {
    isDirectory = statSync(path).isDirectory();
  } catch (err) {
    // Only a missing path is the request's fault; anything else, such as EACCES, is the daemon's.
    const code = err instanceof Error && "code" in err ? err.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR")
      throw new InvalidDirectory(`${path} does not exist`);
    throw err;
  }
  if (!isDirectory) throw new InvalidDirectory(`${path} is not a directory`);
  return path;
}

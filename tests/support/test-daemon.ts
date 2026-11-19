import { isAbsolute } from "node:path";

/**
 * The Rust daemon's binary a run names in `BAZHEN_TEST_DAEMON_BIN`, which then stands in for the
 * TypeScript daemon wherever a test starts one, while both are built; none when it is unset or
 * empty. A path that isn't absolute throws: a test's daemon runs from a directory of its own, and
 * a bare name would be looked up on `PATH`. It goes at the cutover.
 */
export function testDaemonBin(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const bin = env["BAZHEN_TEST_DAEMON_BIN"];
  if (bin === undefined || bin === "") return undefined;
  if (!isAbsolute(bin)) {
    throw new Error(`BAZHEN_TEST_DAEMON_BIN names ${bin}, which isn't an absolute path`);
  }
  return bin;
}

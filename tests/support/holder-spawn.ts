// The one way a holder test starts a process: in the run's HOME, with an environment
// ./holder-home.ts checks, so nothing it starts can reach the user's tmux servers or files.
// tests/holder may not import child_process or node-pty itself (scripts/lint-config.ts); the
// helper that spawns a real holder belongs here too, passing its spec's env the same way.

import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { holderEnv, requireHolderEnv, testHome, userDir } from "./holder-home.ts";

/** Runs `argv` to its end in the run's HOME, with `env`, which `requireHolderEnv` must pass. */
export function runInHome(
  argv: readonly [string, ...string[]],
  env: Readonly<Record<string, string>> = holderEnv(),
): SpawnSyncReturns<string> {
  const [file, ...args] = argv;
  return spawnSync(file, args, {
    env: requireHolderEnv(env),
    cwd: userDir(testHome()),
    encoding: "utf8",
  });
}

/** The pid of a process that has exited and been reaped, as a closed holder's is. */
export const exitedPid = (): number => runInHome(["true"]).pid;

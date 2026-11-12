import { spawn } from "node:child_process";
import { closeSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { filterEnv, type EnvRules } from "@bazhen/core";
import { answers } from "./socket/client.ts";

export interface DetachOptions {
  /** The daemon's own entry point, run again without `--detach`. */
  readonly entry: string;
  readonly socket: string;
  readonly stateDir: string;
  readonly url: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly envRules: EnvRules;
}

const READY_WITHIN_MS = 10_000;
/** What Bazhen sets for each agent: started from inside one, the daemon must not carry it. */
const PER_AGENT = new Set(["BAZHEN_AGENT_ID", "BAZHEN_SOCKET"]);
const LOG_TAIL_LINES = 20;

/**
 * The environment the daemon runs with: the user's, minus what no agent may inherit, plus
 * Bazhen's own settings, which the daemon reads and strips again before any agent sees them. So
 * the daemon never holds a parent harness's session variables or messaging socket (§2, §9.5).
 */
export function daemonEnv(
  env: Readonly<Record<string, string | undefined>>,
  rules: EnvRules,
): Record<string, string> {
  const own = Object.entries(env).filter(
    (entry): entry is [string, string] =>
      entry[0].startsWith("BAZHEN_") && !PER_AGENT.has(entry[0]) && entry[1] !== undefined,
  );
  return { ...filterEnv(env, rules).env, ...Object.fromEntries(own) };
}

/**
 * `bazhen start`: the daemon in a session of its own, outliving the terminal that started it, with
 * its output in the state directory. Resolves with the exit code for the starting process.
 */
export async function detach(o: DetachOptions): Promise<number> {
  if (await answers(o.socket)) {
    console.log(`bazhen is already running at ${o.url}`);
    return 0;
  }
  const logFile = join(o.stateDir, "daemon.log");
  const log = openSync(logFile, "a");
  try {
    spawn(process.execPath, [o.entry], {
      detached: true,
      // Not the starting shell's directory, which the daemon would otherwise hold open.
      cwd: "/",
      stdio: ["ignore", log, log],
      env: daemonEnv(o.env, o.envRules),
    }).unref();
  } finally {
    closeSync(log);
  }
  for (const start = Date.now(); Date.now() - start < READY_WITHIN_MS;) {
    if (await answers(o.socket)) {
      console.log(`bazhen is running at ${o.url}`);
      return 0;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const tail = readFileSync(logFile, "utf8").trimEnd().split("\n").slice(-LOG_TAIL_LINES);
  console.error(`bazhen did not start within ${READY_WITHIN_MS / 1000} s; ${logFile} ends:`);
  console.error(tail.join("\n"));
  return 1;
}

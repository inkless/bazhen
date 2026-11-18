import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `arg` quoted for sh, as one word. */
export const shellWord = (arg: string) => `'${arg.replaceAll("'", `'\\''`)}'`;

const programsOf = (home: string) => join(home, "programs");

/**
 * A directory under `home` holding a `claude` that runs the program `queueProgram` queued, as the
 * agent's own process, or else `claude`. The queued script is claimed by a rename, which only one
 * launch can win, under the id of the agent that won it.
 */
export function programsOnPath(home: string, claude: string): string {
  const dir = programsOf(home);
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "claude");
  writeFileSync(
    shim,
    `#!/bin/sh\n` +
      `if mv ${shellWord(`${dir}/next`)} ${shellWord(dir)}"/taken-$BAZHEN_AGENT_ID" 2>/dev/null; then\n` +
      `  exec /bin/sh ${shellWord(dir)}"/taken-$BAZHEN_AGENT_ID"\n` +
      `fi\n` +
      `exec ${shellWord(claude)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return dir;
}

/**
 * Queues `argv` for the next agent the daemon of `home` launches. `launch` launches it and
 * answers its id; the program must have gone to that agent, or the queue is emptied and this
 * throws, since a program left queued would run in place of the next Claude Code.
 */
export async function runAsNextAgent(
  home: string,
  argv: readonly string[],
  launch: () => Promise<string>,
  waitUntil: (done: () => boolean, what: string) => Promise<unknown>,
): Promise<string> {
  const dir = programsOf(home);
  const next = join(dir, "next");
  writeFileSync(next, `exec ${argv.map(shellWord).join(" ")}\n`);
  let agentId: string;
  try {
    agentId = await launch();
    await waitUntil(() => !existsSync(next), "a launch to take the program");
  } catch (error) {
    rmSync(next, { force: true });
    throw error;
  }
  if (!existsSync(join(dir, `taken-${agentId}`))) {
    throw new Error(`another launch took the program meant for ${agentId}`);
  }
  return agentId;
}

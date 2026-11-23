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
 * A `$SHELL` under `home` that runs the program `runAsNextShell` queued, as a shell terminal's own
 * process, or else `shell` with the arguments it was given. The queued script is claimed by a
 * rename, which only one shell can win, under the id of the terminal that won it. Only a shell
 * terminal claims it: an agent's process, or a shell started outside a terminal, runs `shell`.
 */
export function programShell(home: string, shell: string): string {
  const dir = programsOf(home);
  mkdirSync(dir, { recursive: true });
  const shim = join(dir, "shell");
  const taken = `${shellWord(dir)}"/taken-$BAZHEN_TERMINAL_ID"`;
  writeFileSync(
    shim,
    `#!/bin/sh\n` +
      `if [ -n "\${BAZHEN_TERMINAL_ID-}" ] && [ -z "\${BAZHEN_AGENT_ID-}" ] &&\n` +
      `  mv ${shellWord(`${dir}/next-shell`)} ${taken} 2>/dev/null; then\n` +
      `  exec /bin/sh ${taken}\n` +
      `fi\n` +
      `exec ${shellWord(shell)} "$@"\n`,
  );
  chmodSync(shim, 0o755);
  return shim;
}

/**
 * Queues `argv` in `dir`'s `queue`, runs `open`, and answers the id it answered once the program
 * has gone to it. If it went nowhere the queue is emptied and this throws, since a program left
 * queued would run in place of the next Claude Code or shell; if it went to another, this throws.
 */
async function runQueued(
  dir: string,
  queue: string,
  argv: readonly string[],
  open: () => Promise<string>,
  waitUntil: (done: () => boolean, what: string) => Promise<unknown>,
): Promise<string> {
  const next = join(dir, queue);
  writeFileSync(next, `exec ${argv.map(shellWord).join(" ")}\n`);
  let id: string;
  try {
    id = await open();
    await waitUntil(() => !existsSync(next), "a launch to take the program");
  } catch (error) {
    rmSync(next, { force: true });
    throw error;
  }
  if (!existsSync(join(dir, `taken-${id}`))) {
    throw new Error(`another launch took the program meant for ${id}`);
  }
  return id;
}

/**
 * Queues `argv` for the next agent the daemon of `home` launches. `launch` launches it and
 * answers its id; the program must have gone to that agent, or this throws.
 */
export const runAsNextAgent = (
  home: string,
  argv: readonly string[],
  launch: () => Promise<string>,
  waitUntil: (done: () => boolean, what: string) => Promise<unknown>,
): Promise<string> => runQueued(programsOf(home), "next", argv, launch, waitUntil);

/**
 * Queues `argv` for the next shell the daemon of `home` opens, which runs it as its terminal's
 * process in place of the shell. `open` opens it and answers its terminal's id; the program must
 * have gone to that terminal, or this throws.
 */
export const runAsNextShell = (
  home: string,
  argv: readonly string[],
  open: () => Promise<string>,
  waitUntil: (done: () => boolean, what: string) => Promise<unknown>,
): Promise<string> => runQueued(programsOf(home), "next-shell", argv, open, waitUntil);

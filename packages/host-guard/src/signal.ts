// The one module that sends signals. A signal reaches only a process group this process started,
// or the process of a pane that one of Bazhen's own tmux servers vouched for: a stray pid ends
// someone else's work, and a stray negative one their whole session.

import { spawn, type SpawnOptions } from "node:child_process";

const groups = new Set<number>();
const vouched = new WeakSet<PaneGroup>();

/** A pane's process group, as a private tmux server reported it (`TmuxServer.paneGroup`). */
export interface PaneGroup {
  readonly pid: number;
}

const isPid = (pid: number) => Number.isInteger(pid) && pid > 1;

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined;

/** A pane's process group, recorded as one `signalPane` may reach. Only tmux.ts calls this. */
export function vouch(pid: number): PaneGroup {
  if (!isPid(pid)) throw new RangeError(`refusing to vouch for pid ${pid}`);
  const pane = Object.freeze({ pid });
  vouched.add(pane);
  return pane;
}

function send(target: number, signal: NodeJS.Signals): void {
  try {
    process.kill(target, signal);
  } catch (error) {
    // The group already exited; that is the caller's to notice.
    if (errorCode(error) !== "ESRCH") throw error;
  }
}

/** Starts a child leading a process group of its own, which `signalGroup` may then reach. */
export function spawnGroup(command: string, args: readonly string[], opts: SpawnOptions) {
  const child = spawn(command, args, { ...opts, detached: true });
  if (child.pid !== undefined) groups.add(child.pid);
  return child;
}

/** Signals the whole group of a child that `spawnGroup` started, and nothing else. */
export function signalGroup(child: { readonly pid?: number | undefined }, signal: NodeJS.Signals) {
  const pid = child.pid;
  if (pid === undefined) return;
  if (!groups.has(pid)) throw new RangeError(`refusing to signal group ${pid}: not started here`);
  send(-pid, signal);
}

/** Signals a pane's process and every tool it started, as Ctrl-C or a hangup would. */
export function signalPane(pane: PaneGroup, signal: NodeJS.Signals): void {
  if (!vouched.has(pane)) throw new RangeError(`refusing to signal group ${pane.pid}: unvouched`);
  send(-pane.pid, signal);
}

/** Whether a process exists; one this user may not signal counts as alive. */
export function isAlive(pid: number): boolean {
  if (!isPid(pid)) throw new RangeError(`refusing to probe pid ${pid}`);
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

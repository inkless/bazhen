// The one module that sends signals. A signal reaches only a process group this process started,
// or the process of a pane that one of Bazhen's own tmux servers vouched for: a stray pid ends
// someone else's work, and a stray negative one their whole session.

import { spawn, type SpawnOptions } from "node:child_process";

const groups = new Set<number>();
/** Each proof's expiry; a proof is used once, and only within a second of the check behind it. */
const vouched = new WeakMap<PaneGroup, number>();
const PROOF_MS = 1_000;

/** A live pane's process group, as one of Bazhen's own tmux servers reported it. */
export interface PaneGroup {
  readonly pid: number;
  readonly server: string;
  readonly pane: string;
  readonly generation: string;
}

const isPid = (pid: number) => Number.isInteger(pid) && pid > 1;

const errorCode = (error: unknown) =>
  error instanceof Error && "code" in error ? error.code : undefined;

/** A live pane's process group, as one `signalPane` may reach once. Only tmux.ts calls this. */
export function vouch(group: PaneGroup, now = Date.now()): PaneGroup {
  if (!isPid(group.pid)) throw new RangeError(`refusing to vouch for pid ${group.pid}`);
  const proof = Object.freeze({ ...group });
  vouched.set(proof, now + PROOF_MS);
  return proof;
}

/** Whether the target existed; a group that already exited is the caller's to notice. */
function send(target: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
    return false;
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
  // Kept until the whole group is gone, not just its leader: a group outlives the child that
  // leads it, and is still this process's to stop.
  if (!send(-pid, signal)) groups.delete(pid);
}

/** Signals a pane's process and every tool it started, as Ctrl-C or a hangup would. */
export function signalPane(pane: PaneGroup, signal: NodeJS.Signals, now = Date.now()): void {
  const expiry = vouched.get(pane);
  vouched.delete(pane);
  if (expiry === undefined) throw new RangeError(`refusing to signal group ${pane.pid}: unvouched`);
  if (now > expiry) throw new RangeError(`refusing to signal group ${pane.pid}: stale proof`);
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

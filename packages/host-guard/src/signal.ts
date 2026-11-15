// The one module that sends signals. A signal reaches only a process group this process started,
// the process of a pane that one of Bazhen's own tmux servers vouched for, one of those servers
// itself, once its process was checked to be that server, or a `bazhen-holder` checked to be the
// one a holder test started: a stray pid ends someone else's work, and a stray negative one their
// whole session.

import { spawn, type SpawnOptions } from "node:child_process";
import { constants } from "node:os";

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

/** A tmux server's own process, checked to be the server on `socket`. */
export interface ServerProcess {
  readonly pid: number;
  readonly socket: string;
}

const servers = new WeakMap<ServerProcess, number>();

/** A checked server process, as one `signalServer` may reach once. Only tmux.ts calls this. */
export function vouchServer(server: ServerProcess, now = Date.now()): ServerProcess {
  if (!isPid(server.pid)) throw new RangeError(`refusing to vouch for pid ${server.pid}`);
  const proof = Object.freeze({ ...server });
  servers.set(proof, now + PROOF_MS);
  return proof;
}

/**
 * Sends a checked tmux server `SIGUSR1`, which makes it recreate its socket. Only that signal,
 * and only to the pid itself: the default action of SIGUSR1 ends any process that is not tmux.
 * Whether the server was still there.
 */
export function signalServer(server: ServerProcess, now = Date.now()): boolean {
  const expiry = servers.get(server);
  servers.delete(server);
  if (expiry === undefined) throw new RangeError(`refusing to signal ${server.pid}: unvouched`);
  if (now > expiry) throw new RangeError(`refusing to signal ${server.pid}: stale proof`);
  return send(server.pid, "SIGUSR1");
}

/** A `bazhen-holder` process: its pid, and its start in epoch seconds, as `ps` gives it. */
export interface HolderProcess {
  readonly pid: number;
  readonly start: number;
}

const holders = new WeakMap<HolderProcess, number>();

/** A checked holder process, as one `killHolder` may reach once. Only holder.ts calls this. */
export function vouchHolderProcess(holder: HolderProcess, now = Date.now()): HolderProcess {
  if (!isPid(holder.pid)) throw new RangeError(`refusing to vouch for pid ${holder.pid}`);
  const proof = Object.freeze({ ...holder });
  holders.set(proof, now + PROOF_MS);
  return proof;
}

/**
 * Sends a checked holder `SIGKILL`, to the pid alone: what its child's group does once the holder
 * is gone is the kernel's hang-up to its session. Whether the holder was still there.
 */
export function killHolder(holder: HolderProcess, now = Date.now()): boolean {
  const expiry = holders.get(holder);
  holders.delete(holder);
  if (expiry === undefined) throw new RangeError(`refusing to kill ${holder.pid}: unvouched`);
  if (now > expiry) throw new RangeError(`refusing to kill ${holder.pid}: stale proof`);
  return send(holder.pid, "SIGKILL");
}

/**
 * Why `target`, a pid or a negated pgid, is one no signal may reach, or undefined if it may be
 * tried. 0, 1 and -1 name this process's group, init and every process the user owns; this
 * process and its parent are never the work a signal here is meant to end.
 */
export function unsafeTarget(
  target: number,
  self = process.pid,
  parent = process.ppid,
): string | undefined {
  if (!Number.isSafeInteger(target)) return "not a pid";
  const pid = Math.abs(target);
  if (pid <= 1) return "not a single process or group";
  if (pid === self) return "this process";
  if (pid === parent) return "this process's parent";
  return undefined;
}

/** Whether the target existed; a group that already exited is the caller's to notice. */
function send(target: number, signal: NodeJS.Signals): boolean {
  const unsafe = unsafeTarget(target);
  if (unsafe !== undefined) throw new RangeError(`refusing to signal ${target}: ${unsafe}`);
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

/** How a bounded run ended: it exited 0, exited otherwise, ran out of time, or never started. */
export type RunOutcome = "ok" | "failed" | "timed_out" | "missing";

/**
 * Runs a command by argv, with no shell, in a group of its own, and kills that group if it
 * outlives `timeoutMs`. Never throws: a command that can't start answers `missing`. Not exported
 * from the package: the notifiers in notify.ts are the only way in, each with its own argv.
 */
export function runBounded(
  command: string,
  args: readonly string[],
  opts: { readonly timeoutMs: number; readonly env?: NodeJS.ProcessEnv },
): Promise<RunOutcome> {
  return new Promise((resolve) => {
    const child = spawnGroup(command, args, { stdio: "ignore", env: opts.env ?? process.env });
    const timer = setTimeout(() => {
      signalGroup(child, "SIGKILL");
      resolve("timed_out");
    }, opts.timeoutMs);
    child.once("error", () => {
      clearTimeout(timer);
      forget(child);
      resolve("missing");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      // A notifier that exited on its own leaves nothing to stop; one that timed out stays
      // signalable until its group is gone.
      if (code !== null) forget(child);
      resolve(code === 0 ? "ok" : "failed");
    });
  });
}

const forget = (child: { readonly pid?: number | undefined }) => {
  if (child.pid !== undefined) groups.delete(child.pid);
};

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

// Node ignores SIGPIPE and starts its inspector on SIGUSR1, so neither would end this process.
const NOT_FATAL_TO_NODE = new Set<NodeJS.Signals>(["SIGPIPE", "SIGUSR1"]);

/**
 * Ends this process by `signal`, the way the child it ran for ended, so its own parent (nextest,
 * a shell) reads the same death rather than an exit code standing for it. A signal Node won't die
 * of ends it with the shell's code for that signal instead.
 */
export function dieBy(signal: NodeJS.Signals): never {
  const code = 128 + constants.signals[signal];
  if (!NOT_FATAL_TO_NODE.has(signal)) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  }
  // A signal whose default action doesn't end a process gets here too.
  process.exit(code);
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

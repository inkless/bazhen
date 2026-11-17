// The one module that sends signals. A signal reaches only a process group this process started,
// the process of a pane that one of Bazhen's own tmux servers vouched for, one of those servers
// itself, once its process was checked to be that server, or a `bazhen-holder` checked by its
// command and start time to be the one recorded: a stray pid ends someone else's work, and a stray
// negative one their whole session.

import { execFileSync, spawn, type SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
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

/** What a holder proof lets its holder be sent: one kind never serves for the other. */
export type HolderUse = "kill" | "rebind";

const holders: Record<HolderUse, WeakMap<HolderProcess, number>> = {
  kill: new WeakMap(),
  rebind: new WeakMap(),
};

/** A checked holder process, as one signal of `use` may reach once. Only holder.ts calls this. */
export function vouchHolderProcess(
  holder: HolderProcess,
  use: HolderUse,
  now = Date.now(),
): HolderProcess {
  if (!isPid(holder.pid)) throw new RangeError(`refusing to vouch for pid ${holder.pid}`);
  const proof = Object.freeze({ ...holder });
  holders[use].set(proof, now + PROOF_MS);
  return proof;
}

function spend(holder: HolderProcess, use: HolderUse, now: number): void {
  const expiry = holders[use].get(holder);
  holders[use].delete(holder);
  if (expiry === undefined) throw new RangeError(`refusing to signal ${holder.pid}: unvouched`);
  if (now > expiry) throw new RangeError(`refusing to signal ${holder.pid}: stale proof`);
}

/**
 * Sends a checked holder `SIGKILL`, to the pid alone: what its child's group does once the holder
 * is gone is the kernel's hang-up to its session. Whether the holder was still there.
 */
export function killHolder(holder: HolderProcess): boolean {
  return killHolderAt(holder, Date.now());
}

/** `killHolder` at the time `now`, for the expiry's tests. Not exported from the package. */
export function killHolderAt(holder: HolderProcess, now: number): boolean {
  spend(holder, "kill", now);
  return send(holder.pid, "SIGKILL");
}

/**
 * Sends a checked holder `SIGUSR1`, which makes it bind its socket again where the file has gone.
 * Only that signal, and only to the pid itself. Whether the holder was still there.
 */
export function rebindHolder(holder: HolderProcess): boolean {
  return rebindHolderAt(holder, Date.now());
}

/** `rebindHolder` at the time `now`, for the expiry's tests. Not exported from the package. */
export function rebindHolderAt(holder: HolderProcess, now: number): boolean {
  spend(holder, "rebind", now);
  return send(holder.pid, "SIGUSR1");
}

/** A signal refused for its target, before anything was sent: a fault, never a gone group. */
export class UnsafeTarget extends RangeError {}

/**
 * Lets a caller treat a group that has gone as done, and nothing else: a refusal of the target
 * itself is rethrown, so a fault never passes for a run that already ended.
 */
export function rethrowUnsafe(error: unknown): void {
  if (error instanceof UnsafeTarget) throw error;
}

let group: number | undefined;

/** A process group read as text, or NaN for anything but one above 1: 0 and 1 aren't ours. */
const asGroup = (text: string | undefined) => {
  const pgid = Number(text?.trim() === "" ? Number.NaN : text);
  return Number.isSafeInteger(pgid) && pgid > 1 ? pgid : Number.NaN;
};

/** The process group in a /proc/<pid>/stat line: the fifth field, past the command's `)`. */
export const groupInStat = (stat: string) =>
  asGroup(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[2]);

/** The process group `ps -o pgid=` printed. */
export const groupInPs = (out: string) => asGroup(out);

/**
 * This process's group, which a negated pid of it would end along with the run that started
 * this one: from /proc/self/stat, or `ps` where there is no /proc. NaN if neither says, and the
 * floor then refuses every group.
 */
function thisGroup(): number {
  if (group !== undefined) return group;
  try {
    group = groupInStat(readFileSync("/proc/self/stat", "utf8"));
  } catch {
    try {
      group = groupInPs(
        execFileSync("ps", ["-o", "pgid=", "-p", String(process.pid)], { encoding: "utf8" }),
      );
    } catch {
      group = Number.NaN;
    }
  }
  return group;
}

/**
 * Why `target`, a pid or a negated pgid, is one no signal may reach, or undefined if it may be
 * tried. 0, 1 and -1 name this process's group, init and every process the user owns; this
 * process, its parent and its group are never the work a signal here is meant to end. A group
 * signal is refused outright while this process's own group can't be read.
 */
export function unsafeTarget(
  target: number,
  self = process.pid,
  parent = process.ppid,
  ownGroup = thisGroup(),
): string | undefined {
  if (!Number.isSafeInteger(target)) return "not a pid";
  const pid = Math.abs(target);
  if (pid <= 1) return "not a single process or group";
  if (pid === self) return "this process";
  if (pid === parent) return "this process's parent";
  if (target < 0 && !Number.isSafeInteger(ownGroup)) return "this process's group is unknown";
  if (pid === ownGroup) return "this process's group";
  return undefined;
}

/** Whether the target existed; a group that already exited is the caller's to notice. */
function send(target: number, signal: NodeJS.Signals): boolean {
  const unsafe = unsafeTarget(target);
  if (unsafe !== undefined) throw new UnsafeTarget(`refusing to signal ${target}: ${unsafe}`);
  try {
    process.kill(target, signal);
    return true;
  } catch (error) {
    if (errorCode(error) !== "ESRCH") throw error;
    return false;
  }
}

/**
 * Options for `spawnGroup`, without the ones Node enforces with a kill of its own: the group is
 * signalled only through `signalGroup`.
 */
export type GroupSpawnOptions = Omit<SpawnOptions, "timeout" | "killSignal" | "signal"> & {
  readonly timeout?: never;
  readonly killSignal?: never;
  readonly signal?: never;
};

/** Starts a child leading a process group of its own, which `signalGroup` may then reach. */
export function spawnGroup(command: string, args: readonly string[], opts: GroupSpawnOptions) {
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

/** A child process as Node holds it until it is reaped: `ChildProcess` is one. */
export interface OwnChild {
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  kill(signal?: NodeJS.Signals): boolean;
}

/**
 * Signals a child this process spawned and still holds, and nothing else: Node sends through the
 * child's own handle, and only until it is reaped, so a pid reused since is out of its reach.
 * Whether it was sent; never once the child is known to have ended.
 */
export function signalOwnChild(child: OwnChild, signal: NodeJS.Signals): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return false;
  return child.kill(signal);
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

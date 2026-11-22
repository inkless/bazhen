import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, openSync, statSync } from "node:fs";
import { type Answer, probe, silence } from "./probe.ts";

/**
 * The longest a stopping daemon drains with its socket already gone, holding its lock: the Rust
 * daemon's (`SERVING.drain` in `serve.rs`, which a test holds this to).
 */
export const DRAIN_MS = 5000;

/** How long a start waits on a lock another daemon holds without answering (`LOCK_WAIT`). */
export const LOCK_WAIT_MS = DRAIN_MS + 1000;

const RETRY_MS = 100;

/**
 * Whether this daemon takes the start-up lock. Node has no `flock`, so it is taken through
 * util-linux's `flock(1)`, which macOS doesn't have. There, start-up only probes the socket, so a
 * stuck daemon, whose full backlog XNU refuses as it does a stale socket, and two starts racing
 * each other aren't caught. The Rust daemon takes the lock on both.
 */
export const LOCKS = process.platform === "linux";

/** The lock file for the daemon on `socket`, as `lock_of` in `lock.rs` names it. Never removed. */
export function lockOf(socket: string): string {
  return `${socket}.lock`;
}

/** Why the lock can't be tried at all. */
export class LockUnavailable extends Error {}

/**
 * The open lock file, holding an exclusive `flock` (`lock.rs`) until it is closed or the process
 * ends, or null while another open of it holds it. `flock(1)` locks the open file description it
 * is handed as its fd 3 and exits, and the lock stays with this process's fd, which, as every fd
 * Node opens, is close-on-exec, so no holder or shell keeps it.
 */
export function tryLock(path: string): number | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
  } catch (err) {
    throw new LockUnavailable(err instanceof Error ? err.message : String(err));
  }
  return lockOpened(fd, path);
}

/**
 * The lock on `fd`, opened at `path`, or null while it is held, or once `path` names another file:
 * one removed between the open and the lock may have been made afresh and locked by another start,
 * which a lock on the old one wouldn't hold off. Closes `fd` unless it returns it.
 */
export function lockOpened(fd: number, path: string): number | null {
  // Short flags: busybox's flock has no long ones.
  const ran = spawnSync("flock", ["-n", "-x", "3"], {
    stdio: ["ignore", "ignore", "pipe", fd],
    encoding: "utf8",
  });
  let kept: boolean;
  try {
    kept = ran.status === 0 && sameFile(fd, path);
  } catch (err) {
    closeSync(fd);
    throw new LockUnavailable(err instanceof Error ? err.message : String(err));
  }
  if (kept) return fd;
  closeSync(fd);
  if (ran.status === 0 || ran.status === 1) return null;
  const code = ran.error !== undefined && "code" in ran.error ? ran.error.code : undefined;
  if (code === "ENOENT") throw new LockUnavailable("flock isn't on PATH (util-linux has it)");
  throw new LockUnavailable(
    ran.error?.message ?? (ran.stderr.trim() || `flock exited ${ran.status}`),
  );
}

function sameFile(fd: number, path: string): boolean {
  const held = fstatSync(fd);
  const named = statSync(path, { throwIfNoEntry: false });
  return named !== undefined && named.dev === held.dev && named.ino === held.ino;
}

/** What start-up got: the lock's fd, null where it takes none, or why it won't start. */
export type Claimed =
  | { readonly kind: "taken"; readonly fd: number | null }
  | { readonly kind: "refused"; readonly message: string };

export interface ClaimOptions {
  readonly waitMs?: number;
  readonly probe?: (socket: string) => Promise<Answer>;
  readonly locks?: boolean;
}

/**
 * The start-up lock for the daemon on `socket`, taken only where nothing answers there (`claim` in
 * `lock.rs`). While another daemon holds it, silently, it may be starting, or stopping with its
 * socket already gone, so the lock is tried again for up to `waitMs` before the start gives up.
 */
export async function claim(socket: string, options: ClaimOptions = {}): Promise<Claimed> {
  const ask = options.probe ?? probe;
  const lock = lockOf(socket);
  if (!(options.locks ?? LOCKS)) return free(socket, await ask(socket), null);
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const begun = Date.now();
  for (;;) {
    let fd: number | null;
    try {
      fd = tryLock(lock);
    } catch (err) {
      if (!(err instanceof LockUnavailable)) throw err;
      return { kind: "refused", message: `bazhen can't lock ${lock}: ${err.message}` };
    }
    if (fd !== null) {
      // A daemon of a build without the lock, or one whose lock file someone removed.
      const found = free(socket, await ask(socket), fd);
      if (found.kind === "refused") closeSync(fd);
      return found;
    }
    if ((await ask(socket)).kind === "daemon") return running(socket);
    if (Date.now() - begun >= waitMs) {
      return {
        kind: "refused",
        message: `bazhen won't start: another daemon holds ${lock} but doesn't answer on ${socket}; it may be stuck`,
      };
    }
    await new Promise((r) => setTimeout(r, RETRY_MS));
  }
}

function free(socket: string, found: Answer, fd: number | null): Claimed {
  if (found.kind === "silent") return { kind: "refused", message: silence(socket, found.seen) };
  if (found.kind === "daemon") return running(socket);
  return { kind: "taken", fd };
}

function running(socket: string): Claimed {
  return { kind: "refused", message: `bazhen is already running on ${socket}` };
}

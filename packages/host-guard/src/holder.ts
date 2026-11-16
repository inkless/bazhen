// Starts `bazhen-holder` processes, and checks that a pid is still a holder this process knows,
// by its command and start time, before signal.ts may signal it: a pid reused since by anything
// else is left alone.

import { spawn as spawnChild } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { type HolderProcess, killHolder, vouchHolderProcess } from "./signal.ts";
import { type PsReading, readProcess, rootRefusal, socketRefusal, START_SKEW_S } from "./tmux.ts";

export const HOLDER_COMMAND = "bazhen-holder";

/** What a holder writes on stdout once it serves its socket, and nothing before. */
const READY = "ready\n";
/** The longest socket path a holder binds: macOS's `sun_path` less its NUL. */
export const HOLDER_SOCKET_MAX_BYTES = 103;
const TERMINAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** How long a holder that never said `ready` has to show as the holder, to be killed. */
const VOUCH_MS = 1_000;
const VOUCH_POLL_MS = 20;
/** How long the stderr of a holder that exited has to arrive, after its exit. */
const STDERR_MS = 200;
export const HOLDER_READY_MS = 5_000;

/** Where `root`'s holders bind: one directory, inside the run root, holding nothing else. */
export const holdersDir = (root: string) => join(root, "holders");

/** The socket of the holder for `terminalId` under `root`. */
export const holderSocket = (root: string, terminalId: string) =>
  join(holdersDir(root), `${terminalId}.sock`);

/**
 * Why a holder for `terminalId` may not bind `socket` under the run root `root`, by path alone,
 * or undefined when it may: it must be exactly `holderSocket(root, terminalId)`, short enough for
 * every OS to bind.
 */
export function holderSocketRefusal(
  socket: string,
  root: string,
  terminalId: string,
): string | undefined {
  if (!TERMINAL_ID.test(terminalId)) return `${JSON.stringify(terminalId)} is no terminal id`;
  if (!isAbsolute(root) || resolve(root) !== root) {
    return `its root ${root} is not an absolute, normalized path`;
  }
  const outside = socketRefusal(socket, holdersDir(root), [], false);
  if (outside !== undefined) return outside;
  if (socket !== holderSocket(root, terminalId)) {
    return `it is not ${holderSocket(root, terminalId)}`;
  }
  const bytes = Buffer.byteLength(socket);
  if (bytes > HOLDER_SOCKET_MAX_BYTES) {
    return `it is ${bytes} bytes, over the ${HOLDER_SOCKET_MAX_BYTES} a socket path may be`;
  }
  return undefined;
}

/** The holder didn't say `ready`: how it ended, if it did, and what it wrote on stderr. */
export class HolderStartFailed extends Error {
  /**
   * Its exit code, the signal that ended it, `silent` for one that said nothing in time, or
   * `unstarted` for a binary that couldn't be run at all.
   */
  readonly ending: { readonly code: number } | { readonly signal: string } | "silent" | "unstarted";
  readonly stderr: string;
  /** Whether it may still run: one `ps` didn't show as the holder is never killed. */
  readonly running: boolean;

  constructor(ending: HolderStartFailed["ending"], stderr: string, detail = "", running = false) {
    const how =
      ending === "silent"
        ? "it said nothing in time"
        : ending === "unstarted"
          ? "it couldn't be run"
          : "code" in ending
            ? `it exited ${ending.code}`
            : `${ending.signal} ended it`;
    super(`the holder didn't start: ${how}${detail}: ${stderr.trim() || "(no stderr)"}`);
    this.name = "HolderStartFailed";
    this.ending = ending;
    this.stderr = stderr;
    this.running = running;
  }
}

/** A started process, as `startHolder` uses it: Node's `ChildProcess` is one. */
export interface HolderChild {
  readonly pid?: number | undefined;
  readonly stdin: Writable | null;
  readonly stdout: Readable | null;
  readonly stderr: Readable | null;
  once(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
  once(event: "error", listener: (error: Error) => void): this;
  unref(): void;
}

export interface StartHolderOptions {
  readonly binary: string;
  /** The private run root, whose `holders` directory the spec's socket must be in. */
  readonly root: string;
  /** The spawn spec, sent on stdin as JSON. */
  readonly spec: { readonly terminalId: string; readonly socket: string };
  /** The holder's own environment; its child's travels in the spec. */
  readonly env: Readonly<Record<string, string>>;
  /** Where the holder is started from; it moves to `/` before it starts anything. */
  readonly cwd?: string;
  readonly readyMs?: number;
  /** An argv run in place of the binary, which then gets the binary as its last argument. */
  readonly launcher?: readonly [string, ...string[]];
  /**
   * Called once the holder runs and before it reads its spec, so the caller can record it before
   * it can outlive the call. One that throws stops the start, and the holder is ended.
   */
  readonly onStarted?: (holder: HolderProcess) => void | Promise<void>;
}

export interface StartedHolder extends HolderProcess {
  /** How it ended, once it has: its exit code, or null for a signal. */
  readonly exited: Promise<number | null>;
}

export interface StartSeams {
  readonly spawn?: (
    file: string,
    args: readonly string[],
    options: { env: Record<string, string>; cwd: string },
  ) => HolderChild;
  readonly read?: (pid: number) => Promise<PsReading>;
  readonly now?: () => number;
}

const realSpawn: NonNullable<StartSeams["spawn"]> = (file, args, options) =>
  spawnChild(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });

/**
 * Starts a holder, as a plain child, since it starts a session of its own and a group leader
 * can't, and resolves once it says `ready`, when its socket takes connections. Anything else
 * rejects with `HolderStartFailed`, and a holder still running then is killed, if `ps` shows it is
 * the holder; one it can't vouch for is left alone and named in the error.
 */
export async function startHolder(
  options: StartHolderOptions,
  seams: StartSeams = {},
): Promise<StartedHolder> {
  const { binary, root, spec } = options;
  const refusal = holderSocketRefusal(spec.socket, root, spec.terminalId);
  if (refusal !== undefined)
    throw new RangeError(`refusing holder socket ${spec.socket}: ${refusal}`);
  privateHoldersDir(root, spec.socket);
  const read = seams.read ?? readProcess;
  const [file, ...args] = options.launcher === undefined ? [binary] : [...options.launcher, binary];
  const child = (seams.spawn ?? realSpawn)(file, args, {
    env: { ...options.env },
    cwd: options.cwd ?? "/",
  });
  let ending: { code: number } | { signal: string } | undefined;
  const exited = new Promise<number | null>((done) =>
    child.once("exit", (code, signal) => {
      ending = code !== null ? { code } : { signal: signal ?? "a signal" };
      done(code);
    }),
  );
  const failed = new Promise<Error>((done) => child.once("error", done));
  const pid = child.pid;
  if (pid === undefined) throw new HolderStartFailed("unstarted", (await failed).message);
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
  const stderrEnded = new Promise<void>((done) => {
    child.stderr?.once("end", done).once("error", () => done());
    if (child.stderr === null) done();
  });
  const fail = async (detail: string, holder: HolderProcess | null): Promise<never> => {
    child.stdin?.end();
    // Before the kill, whose end would read as the holder's own.
    const how = ending ?? "silent";
    const left =
      holder === null
        ? null
        : await endUnready(holder, () => ending !== undefined, read, seams.now);
    await Promise.race([stderrEnded, delay(STDERR_MS)]);
    const note = left?.note ? `; ${left.note}` : "";
    throw new HolderStartFailed(how, stderr, `${detail}${note}`, left?.running ?? false);
  };
  const reading = await read(pid);
  if (typeof reading === "string") return fail(`, and ps found it ${reading} at once`, null);
  const holder = { pid, start: reading.start };
  try {
    await options.onStarted?.(holder);
  } catch (error) {
    await fail("", holder).catch(() => {});
    throw error;
  }
  const line = firstLine(child, exited, options.readyMs ?? HOLDER_READY_MS);
  child.stdin?.end(JSON.stringify(spec));
  const said = await line;
  if (said !== READY) {
    return fail(said === null ? "" : `, saying ${JSON.stringify(said)}`, holder);
  }
  child.stdout?.destroy();
  child.stderr?.destroy();
  child.unref();
  return { ...holder, exited };
}

/**
 * Makes `root`'s holders directory if it isn't there, and throws unless it and `root` are
 * directories of this user's that no one else can enter, as a holder checks of its own too.
 */
function privateHoldersDir(root: string, socket: string): void {
  const uid = process.getuid?.() ?? -1;
  const refuse = (why: string) => new RangeError(`refusing holder socket ${socket}: ${why}`);
  const unsafeRoot = rootRefusal(root, uid);
  if (unsafeRoot !== undefined) throw refuse(unsafeRoot);
  const dir = holdersDir(root);
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const unsafeDir = rootRefusal(dir, uid);
  if (unsafeDir !== undefined) throw refuse(unsafeDir);
}

/** The child's first line, or null for none: it ended first, or said none within `ms`. */
function firstLine(child: HolderChild, exited: Promise<unknown>, ms: number) {
  return new Promise<string | null>((done) => {
    let out = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      out += chunk;
      const end = out.indexOf("\n");
      if (end !== -1) done(out.slice(0, end + 1));
    });
    void exited.then(() => done(null));
    setTimeout(() => done(null), ms).unref();
  });
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms).unref());

/**
 * Kills a holder that never said `ready`, once `ps` shows it is the holder, as a launcher that
 * execs it soon does; one that exits meanwhile needs nothing. Whether it may still run.
 */
async function endUnready(
  holder: HolderProcess,
  gone: () => boolean,
  read: (pid: number) => Promise<PsReading>,
  now: () => number = Date.now,
): Promise<{ readonly running: boolean; readonly note: string }> {
  const deadline = now() + VOUCH_MS;
  let proof: HolderProcess | null = null;
  while (!gone() && proof === null && now() < deadline) {
    proof = await vouchHolder(holder, read, now);
    if (proof === null) await delay(VOUCH_POLL_MS);
  }
  if (gone()) return { running: false, note: "" };
  if (proof === null) {
    const note = `pid ${holder.pid} is left running, as ps doesn't show it is the holder`;
    return { running: true, note };
  }
  return { running: false, note: killHolder(proof, now()) ? "it was killed" : "" };
}

/**
 * A proof `killHolder` takes, if `ps` shows `holder.pid` as a `bazhen-holder` that started within
 * `START_SKEW_S` of `holder.start`; null for a pid with no process, an unreadable one, or one that
 * is something else now.
 */
export async function vouchHolder(
  holder: HolderProcess,
  read: (pid: number) => Promise<PsReading> = readProcess,
  now: () => number = Date.now,
): Promise<HolderProcess | null> {
  const reading = await read(holder.pid);
  if (typeof reading === "string") return null;
  if (basename(reading.comm) !== HOLDER_COMMAND) return null;
  if (Math.abs(reading.start - holder.start) > START_SKEW_S) return null;
  return vouchHolderProcess(holder, now());
}

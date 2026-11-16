// Starts `bazhen-holder` processes, and checks that a pid is still a holder, by its command and
// start time, before signal.ts may signal it: a pid reused since by anything else is left alone.
//
// The package exports only the forms without seams. The seamed ones take a `ps` reading and a
// clock, which can vouch for any pid, so they stay in this module and its tests.

import { spawn as spawnChild } from "node:child_process";
import { lstatSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import {
  type HolderProcess,
  type HolderUse,
  killHolder,
  rebindHolder,
  vouchHolderProcess,
} from "./signal.ts";
import { type PsReading, readProcess, rootRefusal, START_SKEW_S } from "./tmux.ts";

export const HOLDER_COMMAND = "bazhen-holder";

/** What a holder writes on stdout once it serves its socket, and nothing before. */
const READY = "ready\n";
/** The most of a holder's first stdout line read: anything longer isn't `ready`. */
const FIRST_LINE_MAX = 64;
/** The most of a holder's stderr kept for its failure. */
const STDERR_MAX = 8 * 1024;
/** The longest socket path a holder binds: macOS's `sun_path` less its NUL. */
export const HOLDER_SOCKET_MAX_BYTES = 103;
/** The longest spawn spec a holder reads: holder/1's request cap, `HOLDER_MAX_REQUEST_BYTES`. */
export const HOLDER_SPEC_MAX_BYTES = 1 << 20;
const TERMINAL_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** How long a holder that never said `ready` has to show as the holder, to be killed. */
const VOUCH_MS = 1_000;
const VOUCH_POLL_MS = 20;
/** How long the stderr of a holder that exited has to arrive, after its exit. */
const STDERR_MS = 200;
export const HOLDER_READY_MS = 5_000;
const READY_MS_MAX = 60_000;

/**
 * A start no process has, for a holder `ps` couldn't read: recorded under it, it names the pid,
 * and no vouch ever matches it.
 */
export const UNKNOWN_START = 0;

/**
 * A name the holder's own environment may hold. Anything else, `BASH_FUNC_ulimit%%` say, could
 * redefine what the limits shell runs.
 */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why `binary` can't be run as a holder, or undefined when it can: it must be an absolute path to
 * a regular file named `bazhen-holder`, as `ps` will show it, or a link to one, since the spec it
 * is sent on stdin would be a script to a shell.
 */
function binaryRefusal(binary: string): string | undefined {
  if (!isAbsolute(binary)) return "it isn't absolute";
  if (basename(binary) !== HOLDER_COMMAND) return `it isn't named ${HOLDER_COMMAND}`;
  let real: string;
  try {
    real = realpathSync(binary);
  } catch {
    return "it doesn't exist";
  }
  if (basename(real) !== HOLDER_COMMAND) return `it links to ${real}`;
  if (!statSync(real).isFile()) return "it isn't a regular file";
  return undefined;
}

/** Where `root`'s holders bind: one directory, inside the run root, holding nothing else. */
export const holdersDir = (root: string) => join(root, "holders");

/** The socket of the holder for `terminalId` under `root`. */
export const holderSocket = (root: string, terminalId: string) =>
  join(holdersDir(root), `${terminalId}.sock`);

/**
 * Why a holder for `terminalId` may not bind `socket` under the run root `root`, by path alone,
 * or undefined when it may: it must be exactly `holderSocket(root, terminalId)`, short enough for
 * every OS to bind. A terminal id of the form Bazhen makes, 37 bytes, leaves the root 52.
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
   * Its exit code, the signal that ended it, `silent` for one that said nothing in time,
   * `unstarted` for a binary that couldn't be run at all, or `unchecked` for one `ps` couldn't
   * read as it started, which may still run.
   */
  readonly ending:
    | { readonly code: number }
    | { readonly signal: string }
    | "silent"
    | "unstarted"
    | "unchecked";
  readonly stderr: string;
  /** Whether it may still run: one `ps` didn't show as the holder is never killed. */
  readonly running: boolean;

  constructor(
    ending: HolderStartFailed["ending"],
    stderr: string,
    {
      detail = "",
      running = false,
      cause,
    }: { detail?: string; running?: boolean; cause?: unknown } = {},
  ) {
    const how =
      ending === "silent"
        ? "it said nothing in time"
        : ending === "unstarted"
          ? "it couldn't be run"
          : ending === "unchecked"
            ? "ps couldn't say what it is"
            : "code" in ending
              ? `it exited ${ending.code}`
              : `${ending.signal} ended it`;
    super(`the holder didn't start: ${how}${detail}: ${stderr.trim() || "(no stderr)"}`, {
      cause,
    });
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
  /** The binary, by absolute path. */
  readonly binary: string;
  /** The private run root, whose `holders` directory the spec's socket must be in. */
  readonly root: string;
  /** The spawn spec, sent on stdin as JSON. */
  readonly spec: { readonly terminalId: string; readonly socket: string };
  /** The holder's own environment; its child's travels in the spec. */
  readonly env: Readonly<Record<string, string>>;
  /** Where the holder is started from; it moves to `/` before it starts anything. */
  readonly cwd?: string;
  /** How long it has to say `ready`, in ms: up to a minute. */
  readonly readyMs?: number;
  /** Limits it runs under, set by a fixed `/bin/sh` that then execs it. */
  readonly limits?: HolderLimits;
  /**
   * Called once the holder runs and before it reads its spec, so the caller can record it before
   * it can outlive the call. One that throws stops the start, and the holder is ended. For a
   * holder `ps` couldn't read, it is called only once it has been given no spec and still runs,
   * with `UNKNOWN_START`.
   */
  readonly onStarted?: (holder: HolderProcess) => void | Promise<void>;
}

export interface HolderLimits {
  /** The CPU-seconds it may use, as `ulimit -t`: one that spins dies of SIGXCPU instead. */
  readonly cpuSeconds?: number;
}

const CPU_SECONDS_MAX = 24 * 60 * 60;

/** The argv that runs `binary` under `limits`: the binary alone, or a fixed shell that execs it. */
function holderArgv(binary: string, limits: HolderLimits | undefined): [string, ...string[]] {
  const cpu = limits?.cpuSeconds;
  if (cpu === undefined) return [binary];
  if (!Number.isSafeInteger(cpu) || cpu <= 0 || cpu > CPU_SECONDS_MAX) {
    throw new RangeError(`cpuSeconds ${cpu} isn't between 1 and ${CPU_SECONDS_MAX}`);
  }
  return ["/bin/sh", "-c", `ulimit -t ${cpu} && exec "$0" "$@"`, binary];
}

export interface StartedHolder extends HolderProcess {
  /** How it ended, once it has: its exit code, or null for a signal. */
  readonly exited: Promise<number | null>;
}

/** The OS calls `startHolder` makes, replaced in its tests so no real process is reached. */
export interface StartSeams {
  readonly spawn?: (
    file: string,
    args: readonly string[],
    options: { env: Record<string, string>; cwd: string },
  ) => HolderChild;
  readonly read?: (pid: number) => Promise<PsReading>;
  readonly kill?: (proof: HolderProcess) => boolean;
}

const realSpawn: NonNullable<StartSeams["spawn"]> = (file, args, options) =>
  spawnChild(file, args, { ...options, stdio: ["pipe", "pipe", "pipe"] });

/** What this process knows of each holder it started, by pid. */
interface Own {
  readonly start: number;
  ready: boolean;
  exited: boolean;
}

/**
 * The holders this process started. One that hasn't said `ready`, or has exited, is never sent a
 * rebind, whatever `ps` says of its pid. Kept until another holder this process starts takes the
 * pid, so an exit is never forgotten.
 */
const own = new Map<number, Own>();

/**
 * Starts a holder, as a plain child, since it starts a session of its own and a group leader
 * can't, and resolves once it says `ready`, when its socket takes connections. Anything else
 * rejects with `HolderStartFailed`, and a holder still running then is killed, if `ps` shows it is
 * the holder; one it can't vouch for is left alone and named in the error.
 *
 * A holder killed after it started its program leaves that program to the hangup its terminal's
 * closing sends, as after any holder's SIGKILL: one that ignores SIGHUP runs on, orphaned.
 */
export function startHolder(options: StartHolderOptions): Promise<StartedHolder> {
  return startHolderWith(options, {});
}

/** `startHolder`, with its OS calls replaced. Not exported from the package. */
export async function startHolderWith(
  options: StartHolderOptions,
  seams: StartSeams,
): Promise<StartedHolder> {
  const { binary, root, spec } = options;
  const readyMs = options.readyMs ?? HOLDER_READY_MS;
  const unfitBinary = binaryRefusal(binary);
  if (unfitBinary !== undefined) {
    throw new RangeError(`refusing holder binary ${binary}: ${unfitBinary}`);
  }
  const badNames = Object.keys(options.env).filter((name) => !ENV_NAME.test(name));
  if (badNames.length > 0) {
    throw new RangeError(`refusing the holder's environment names ${badNames.join(", ")}`);
  }
  if (!Number.isSafeInteger(readyMs) || readyMs <= 0 || readyMs > READY_MS_MAX) {
    throw new RangeError(`readyMs ${readyMs} isn't between 1 and ${READY_MS_MAX}`);
  }
  const refusal = holderSocketRefusal(spec.socket, root, spec.terminalId);
  if (refusal !== undefined) {
    throw new RangeError(`refusing holder socket ${spec.socket}: ${refusal}`);
  }
  const payload = JSON.stringify(spec);
  const size = Buffer.byteLength(payload);
  if (size > HOLDER_SPEC_MAX_BYTES) {
    throw new RangeError(
      `the spawn spec is ${size} bytes, over the ${HOLDER_SPEC_MAX_BYTES} a holder reads`,
    );
  }
  privateHoldersDir(root, spec.socket);
  const read = seams.read ?? readProcess;
  const kill = seams.kill ?? killHolder;
  const [file, ...args] = holderArgv(binary, options.limits);
  const child = (seams.spawn ?? realSpawn)(file, args, {
    env: { ...options.env },
    cwd: options.cwd ?? "/",
  });
  let ending: { code: number } | { signal: string } | undefined;
  let mine: Own | undefined;
  const exited = new Promise<number | null>((done) =>
    child.once("exit", (code, signal) => {
      ending = code !== null ? { code } : { signal: signal ?? "a signal" };
      if (mine !== undefined) mine.exited = true;
      done(code);
    }),
  );
  const failed = new Promise<Error>((done) => child.once("error", done));
  // A holder that exits before it reads its spec breaks the pipe, and a pipe can fail at any
  // time after: its exit says why, and none of them may throw.
  child.stdin?.on("error", () => {});
  child.stdout?.on("error", () => {});
  child.stderr?.on("error", () => {});
  const pid = child.pid;
  if (pid === undefined) throw new HolderStartFailed("unstarted", (await failed).message);
  let stderr = "";
  child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
    if (stderr.length < STDERR_MAX) stderr = (stderr + chunk).slice(0, STDERR_MAX);
  });
  const stderrEnded = new Promise<void>((done) => {
    child.stderr?.once("end", done).once("close", done);
    if (child.stderr === null) done();
  });
  /** Leaves a holder that didn't start to itself: nothing here reads it or waits for it. */
  const letGo = () => {
    child.stdout?.destroy();
    child.stderr?.destroy();
    child.unref();
  };
  const failure = async (detail: string, holder: HolderProcess | null, cause?: unknown) => {
    child.stdin?.end();
    // Before the kill, whose end would read as the holder's own.
    const how = ending ?? "silent";
    const left =
      holder === null ? null : await endUnready(holder, () => ending !== undefined, read, kill);
    await Promise.race([stderrEnded, delay(STDERR_MS)]);
    letGo();
    const note = left?.note ? `; ${left.note}` : "";
    const running = left?.running ?? false;
    return new HolderStartFailed(how, stderr, { detail: `${detail}${note}`, running, cause });
  };
  let reading = await read(pid);
  // `ps` failing once is often only that: it is asked again, for as long as a vouch would be.
  const readUntil = Date.now() + VOUCH_MS;
  const exitedYet = () => ending !== undefined;
  while (typeof reading === "string" && !exitedYet() && Date.now() < readUntil) {
    await delay(VOUCH_POLL_MS);
    reading = await read(pid);
  }
  if (typeof reading === "string") {
    // Unread, it can't be vouched for: given no spec it should exit, and one that doesn't in
    // time may still run, so it is recorded, under a start no vouch matches, for a person.
    child.stdin?.end();
    await Promise.race([exited, delay(STDERR_MS)]);
    const running = ending === undefined;
    let cause: unknown;
    if (running)
      await Promise.resolve(options.onStarted?.({ pid, start: UNKNOWN_START })).catch(
        (e: unknown) => (cause = e),
      );
    await Promise.race([stderrEnded, delay(STDERR_MS)]);
    letGo();
    const detail = `, as ps found it ${reading}`;
    throw new HolderStartFailed(ending ?? "unchecked", stderr, { detail, running, cause });
  }
  const holder = { pid, start: reading.start };
  mine = { start: reading.start, ready: false, exited: ending !== undefined };
  own.set(pid, mine);
  try {
    await options.onStarted?.(holder);
  } catch (error) {
    throw await failure(", as recording it failed", holder, error);
  }
  const line = firstLine(child, exited, readyMs);
  child.stdin?.end(payload);
  const said = await line;
  if (said !== READY) {
    throw await failure(said === null ? "" : `, saying ${JSON.stringify(said)}`, holder);
  }
  mine.ready = true;
  letGo();
  return { ...holder, exited };
}

/**
 * Makes `root`'s holders directory if it isn't there, and throws unless `root` is a directory of
 * this user's that no one else can enter, and the holders directory one too, not a link to one.
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
  const stat = lstatSync(dir);
  if (!stat.isDirectory()) throw refuse(`${dir} is not a directory`);
  if (stat.uid !== uid) throw refuse(`${dir} belongs to another user`);
  if ((stat.mode & 0o077) !== 0) throw refuse(`${dir} is open to other users`);
}

/**
 * The child's first line, or null for none: it ended first, or said none within `ms`. It stops
 * reading once it has decided.
 */
function firstLine(child: HolderChild, exited: Promise<unknown>, ms: number) {
  return new Promise<string | null>((settle) => {
    let out = "";
    const take = (chunk: string) => {
      out += chunk;
      const end = out.indexOf("\n");
      if (end !== -1) done(out.slice(0, end + 1));
      else if (out.length > FIRST_LINE_MAX) done(out.slice(0, FIRST_LINE_MAX));
    };
    const timer = setTimeout(() => done(null), ms);
    timer.unref();
    function done(line: string | null) {
      clearTimeout(timer);
      child.stdout?.off("data", take);
      settle(line);
    }
    child.stdout?.setEncoding("utf8").on("data", take);
    void exited.then(() => done(null));
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
  kill: (proof: HolderProcess) => boolean,
): Promise<{ readonly running: boolean; readonly note: string }> {
  const deadline = Date.now() + VOUCH_MS;
  let proof: HolderProcess | null = null;
  while (!gone() && proof === null && Date.now() < deadline) {
    proof = await vouchHolderWith(holder, "kill", read);
    if (proof === null) await delay(VOUCH_POLL_MS);
  }
  if (gone()) return { running: false, note: "" };
  if (proof === null) {
    const note = `pid ${holder.pid} is left running, as ps doesn't show it is the holder`;
    return { running: true, note };
  }
  return { running: false, note: kill(proof) ? "it was killed" : "" };
}

/** Whether `reading` is a `bazhen-holder` that started within `START_SKEW_S` of `holder.start`. */
const isHolder = (reading: PsReading, holder: HolderProcess) =>
  typeof reading !== "string" &&
  basename(reading.comm) === HOLDER_COMMAND &&
  Math.abs(reading.start - holder.start) <= START_SKEW_S;

/**
 * A proof `killHolder` takes, if `ps` shows `holder.pid` as a `bazhen-holder` that started within
 * `START_SKEW_S` of `holder.start`; null for a pid with no process, an unreadable one, or one that
 * is something else now.
 */
export function vouchHolder(holder: HolderProcess): Promise<HolderProcess | null> {
  return vouchHolderWith(holder, "kill");
}

/** `vouchHolder`, for either use, with `ps` and the clock replaced. Not exported from the package. */
export async function vouchHolderWith(
  holder: HolderProcess,
  use: HolderUse,
  read: (pid: number) => Promise<PsReading> = readProcess,
  now: () => number = Date.now,
): Promise<HolderProcess | null> {
  const reading = await read(holder.pid);
  return isHolder(reading, holder) ? vouchHolderProcess(holder, use, now()) : null;
}

/**
 * Tells a holder to bind its socket again, as one whose socket file was deleted needs (design
 * §5.4): `SIGUSR1`, once `ps` shows `holder.pid` is that holder. One this process started is sent
 * nothing unless it has said `ready` and not exited. Whether it was sent.
 */
export function rebindHolderSocket(holder: HolderProcess): Promise<boolean> {
  return rebindHolderWith(holder, readProcess, rebindHolder);
}

/** `rebindHolderSocket`, with `ps` and the send replaced. Not exported from the package. */
export async function rebindHolderWith(
  holder: HolderProcess,
  read: (pid: number) => Promise<PsReading>,
  send: (proof: HolderProcess) => boolean,
): Promise<boolean> {
  const unfit = () => {
    const mine = own.get(holder.pid);
    if (mine === undefined) return false;
    return !mine.ready || mine.exited || Math.abs(mine.start - holder.start) > START_SKEW_S;
  };
  if (unfit()) return false;
  const reading = await read(holder.pid);
  // Checked again after `ps`, and then sent with no wait between: an exit seen meanwhile counts.
  if (!isHolder(reading, holder) || unfit()) return false;
  return send(vouchHolderProcess(holder, "rebind"));
}

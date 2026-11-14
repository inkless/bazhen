// The one module that runs tmux. Every command names its server by socket path, inside a
// directory its caller owns, and never by `-L` name: a name resolves in the directory the
// user's own servers share, and one wrong socket ends every tmux session on the machine.

import { execFile, execFileSync, type StdioOptions } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { signalServer, vouch, vouchServer, type PaneGroup } from "./signal.ts";

const run = promisify(execFile);
const TIMEOUT_MS = 5_000;

/**
 * `execFile`'s outcome as its promise form gives it, with what the command printed on the error,
 * and with a command its timeout stopped as a failure: tmux's client exits 0 on the SIGTERM a
 * timeout sends it, which `execFile` alone reports as success, with no output.
 */
function settled(
  err: Error | null,
  child: { readonly killed: boolean; readonly exitCode: number | null },
  stdout: string,
  stderr: string,
): Error | null {
  if (err !== null) return Object.assign(err, { stdout, stderr });
  if (!child.killed) return null;
  return Object.assign(new Error("tmux was stopped by its timeout"), {
    code: child.exitCode,
    killed: true,
    signal: null,
    stdout,
    stderr,
  });
}

const real = (path: string) => (existsSync(path) ? realpathSync(path) : path);

/**
 * Where tmux keeps the servers it finds by name, through any symlink: /tmp's and TMUX_TMPDIR's
 * `tmux-<uid>`. No root may hold one.
 */
function sharedDirs(uid: number, tmuxTmpdir: string | undefined): string[] {
  const bases = ["/tmp", "/private/tmp", ...(tmuxTmpdir ? [tmuxTmpdir] : [])];
  return [...new Set(bases.flatMap((base) => [base, real(base)]))].map((b) =>
    join(b, `tmux-${uid}`),
  );
}

const normalized = (path: string) => isAbsolute(path) && resolve(path) === path;

/**
 * Why `socket` may not be used under `root`, or undefined when it may, by path alone. `fold`
 * compares without case, as macOS's file system does.
 */
export function socketRefusal(
  socket: string,
  root: string,
  shared: readonly string[],
  fold: boolean,
): string | undefined {
  if (!normalized(root)) return `its root ${root} is not an absolute, normalized path`;
  if (!normalized(socket)) return "it is not an absolute, normalized path";
  const key = (path: string) => (fold ? path.toLowerCase() : path);
  const within = (dir: string, path: string) => {
    const rel = relative(key(dir), key(path));
    return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  };
  if (socket === root || !within(root, socket)) return `it is not inside ${root}`;
  if (key(basename(socket)) === "default") return "`default` names the user's own server";
  if (shared.some((dir) => within(root, dir) || within(dir, socket))) {
    return "its root holds the directory where the user's own servers live";
  }
  return undefined;
}

/** Why `root` can't hold a server: it must be a directory only this user can enter. */
function rootRefusal(root: string, uid: number): string | undefined {
  if (!existsSync(root)) return `its root ${root} does not exist`;
  const stat = statSync(root);
  if (!stat.isDirectory()) return `its root ${root} is not a directory`;
  if (stat.uid !== uid) return `its root ${root} belongs to another user`;
  if ((stat.mode & 0o077) !== 0) return `its root ${root} is open to other users`;
  return undefined;
}

/** `[major, minor]` of the installed tmux, from `tmux 3.6b` or `tmux next-3.9`. No server runs. */
export function tmuxVersion(): [number, number] {
  const out = execFileSync("tmux", ["-V"], { encoding: "utf8", timeout: TIMEOUT_MS }).trim();
  const match = /^tmux (?:next-)?(\d+)\.(\d+)/.exec(out);
  if (match === null) throw new Error(`Unrecognised tmux version: ${out}`);
  return [Number(match[1]), Number(match[2])];
}

/** The pane option where Bazhen records each terminal's incarnation. */
export const GENERATION_OPTION = "@bazhen_generation";

/** The process a pane is expected to run: its pid and Bazhen's generation for it. */
export interface PaneProcess {
  readonly pid: string;
  readonly generation: string;
}

/** The pane no longer runs the process the caller checked, so nothing may signal it. */
export class PaneRefused extends Error {
  readonly reason: "dead" | "process-replaced";

  constructor(pane: string, reason: PaneRefused["reason"]) {
    super(`refusing to signal pane ${pane}: ${reason}`);
    this.reason = reason;
  }
}

export interface TmuxOptions {
  /** The whole environment of the command; a server it starts copies it into every pane. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeout?: number;
  readonly stdio?: StdioOptions;
  /** The most output the command may print; more fails it. Node's own limit, 1 MiB, by default. */
  readonly maxBytes?: number;
}

const DEFAULT_MAX_BYTES = 1024 * 1024;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Whether a variable can go to tmux's command parser as data: a plain name, and a value with no
 * newline or NUL, which no quoting carries safely. Anything else is refused, never escaped.
 */
export function isSafeEnvEntry(name: string, value = ""): boolean {
  return ENV_NAME.test(name) && !/[\n\r\0]/.test(value);
}

/** One word for tmux's parser: single-quoted, where nothing is special; a quote as `'\''`. */
const tmuxWord = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * The tmux commands that set `set` and unset `unset` in a server's global environment, one per
 * line. A value is only ever a quoted word, so it can't end the command or start another.
 */
export function environmentScript(
  set: Readonly<Record<string, string>>,
  unset: readonly string[],
): string {
  const refused = [
    ...Object.entries(set).filter(([name, value]) => !isSafeEnvEntry(name, value)),
    ...unset.filter((name) => !isSafeEnvEntry(name)).map((name) => [name]),
  ].map(([name]) => name);
  if (refused.length > 0) {
    throw new RangeError(`refusing to pass to tmux, by name only: ${refused.join(", ")}`);
  }
  return [
    ...Object.entries(set).map(([name, value]) => `set-environment -g ${name} ${tmuxWord(value)}`),
    ...unset.map((name) => `set-environment -g -u ${name}`),
  ]
    .map((line) => `${line}\n`)
    .join("");
}

/** A tmux server as a runtime ref records it: its `#{pid}` and `#{start_time}` (epoch seconds). */
export interface ServerIdentity {
  readonly pid: string;
  readonly start: string;
}

/** One process as `ps` describes it: its command, start (epoch seconds) and argument line. */
export interface ProcessFacts {
  readonly comm: string;
  readonly start: number;
  readonly args: string;
}

/**
 * What `ps` showed of a pid: the process, provably none (`absent`), or nothing that can be relied
 * on (`unreadable`: an unexpected exit or a line that won't parse).
 */
export type PsReading = ProcessFacts | "absent" | "unreadable";

/**
 * Whether the server a ref recorded still runs: `serves` only when every check holds, `gone` only
 * when the pid provably has no process or a different one, and `unsure` for anything else, which
 * concludes nothing (foundation-design §7.1).
 */
export type ServerVerdict =
  | { readonly is: "serves" }
  | { readonly is: "gone" }
  | { readonly is: "unsure"; readonly why: string };

/** How far a process's start, as `ps` prints it, may lie from tmux's `#{start_time}`. */
const START_SKEW_S = 2;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `ps -o lstart=` in the C locale and UTC, `Thu Nov 12 17:10:38 2026`, as epoch seconds. */
export function parseLstart(text: string): number | undefined {
  const match = /^\w{3} +(\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(text.trim());
  if (match === null) return undefined;
  const [, mon = "", day, h, m, sec, year] = match;
  const month = MONTHS.indexOf(mon);
  if (month === -1) return undefined;
  return Date.UTC(Number(year), month, Number(day), Number(h), Number(m), Number(sec)) / 1000;
}

/** A tmux server's command: its binary, by name or path, or the name Linux's tmux gives it. */
const TMUX_COMM = /^(?:\S*\/)?tmux(?:: server)?$/;

/** One line of `ps -o lstart=,<column>=`: the start, then the column, which may hold spaces. */
export function parsePsLine(line: string): { start: number; rest: string } | undefined {
  const match = /^(\w{3} +\w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}) +(.+)$/.exec(line.trim());
  const start = parseLstart(match?.[1] ?? "");
  const rest = match?.[2];
  return start === undefined || rest === undefined ? undefined : { start, rest };
}

/**
 * Whether the process `ps` showed is the tmux server `identity` recorded for `socket`. It
 * serves only if all of it holds, since the signal that follows ends any process that is not
 * tmux: a tmux command, `socket` itself in its arguments, and the recorded start. The server keeps
 * the arguments of the command that started it, so its `-S <socket>`, unless its process title was
 * set to `tmux: server (<socket>)`, as tmux does where it can. It is gone only if no process has
 * the pid, or one with nothing of tmux or this socket about it that started at another time. A process that looks like
 * the server but started at another time is unsure: on Linux, a step of the wall clock moves
 * `lstart`.
 */
export function serverVerdict(
  reading: PsReading,
  identity: ServerIdentity,
  socket: string,
): ServerVerdict {
  if (reading === "absent") return { is: "gone" };
  if (reading === "unreadable") return { is: "unsure", why: "ps could not be read" };
  const args = reading.args.trim();
  const ours =
    TMUX_COMM.test(reading.comm) &&
    (args === `tmux: server (${socket})` || ` ${args} `.includes(` -S ${socket} `));
  const recorded = /^\d+$/.test(identity.start) ? Number(identity.start) : undefined;
  const sameStart = recorded !== undefined && Math.abs(reading.start - recorded) <= START_SKEW_S;
  if (ours && sameStart) return { is: "serves" };
  // Gone only for a process nothing ties to tmux or to this socket: a live server that fails the
  // strict test (a wrapped binary, a socket spelled another way) while a clock step skews its
  // start must not read as dead.
  const tmuxLike = basename(reading.comm).includes("tmux") || args.includes(socket);
  if (!tmuxLike && !sameStart && recorded !== undefined) return { is: "gone" };
  return {
    is: "unsure",
    why: ours ? "it started at another time" : `${reading.comm} is not this socket's server`,
  };
}

const PS_ENV = { LC_ALL: "C", TZ: "UTC", PATH: process.env["PATH"] ?? "/usr/bin:/bin" };

/**
 * What `ps` shows of `pid`. Two calls, since macOS cuts the command to 16 characters unless it is
 * the last column; each also prints the start, and the two must agree, so both describe one
 * process. It exits 1 and prints nothing for a pid with no process; any other failure, a line that
 * won't parse, or two that disagree, is unreadable rather than absent.
 */
export async function readProcess(pid: number): Promise<PsReading> {
  const ps = async (column: "comm" | "args") => {
    const args = ["-ww", "-p", String(pid), "-o", `lstart=,${column}=`];
    const { stdout } = await run("ps", args, { env: PS_ENV, timeout: TIMEOUT_MS });
    return parsePsLine(stdout);
  };
  try {
    const comm = await ps("comm");
    const args = await ps("args");
    if (comm === undefined || args === undefined || comm.start !== args.start) return "unreadable";
    return { start: comm.start, comm: comm.rest, args: args.rest };
  } catch (err) {
    return psFailure(err);
  }
}

/**
 * The foreground process group of the terminal `pid` is attached to, as `ps` reports it (`tpgid`):
 * a shell at its prompt leads it; a program it runs in the foreground leads another. A process
 * with no terminal reports none, as -1 or 0.
 */
export async function terminalForeground(pid: number): Promise<number | "absent" | "unreadable"> {
  const read = await terminalGroups([pid]);
  if (read === "unreadable") return read;
  return read.get(pid) ?? "absent";
}

/** The most `terminalGroups` reads back: two short numbers a line, for a few hundred terminals. */
const GROUPS_MAX_BYTES = 64 * 1024;

/**
 * The foreground process group of each of `pids` that has a process, by pid: absent pids are
 * left out, and a run in which none has one is an empty map. A run that fails otherwise, or
 * prints more than a few hundred terminals could, is unreadable rather than half read.
 */
export async function terminalGroups(
  pids: readonly number[],
  maxBytes = GROUPS_MAX_BYTES,
): Promise<Map<number, number> | "unreadable"> {
  if (pids.length === 0) return new Map();
  try {
    const args = ["-p", pids.join(","), "-o", "pid=,tpgid="];
    const { stdout } = await run("ps", args, {
      env: PS_ENV,
      timeout: TIMEOUT_MS,
      maxBuffer: maxBytes,
    });
    return parseGroups(stdout);
  } catch (err) {
    return psFailure(err) === "absent" ? new Map() : "unreadable";
  }
}

/** `ps -o pid=,tpgid=` lines, by pid. */
export function parseGroups(out: string): Map<number, number> {
  const rows = out.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(-?\d+)\s*$/.exec(line);
    return match === null ? [] : [[Number(match[1]), Number(match[2])] as const];
  });
  return new Map(rows);
}

/** A failed `ps -p`: absent only for exit 1 with nothing printed, as for a pid with no process. */
export function psFailure(err: unknown): "absent" | "unreadable" {
  const quiet = (key: string) => String(Reflect.get(Object(err), key) ?? "").trim() === "";
  const code = Reflect.get(Object(err), "code");
  return code === 1 && quiet("stdout") && quiet("stderr") ? "absent" : "unreadable";
}

/** The pid a ref recorded, if it can name a process at all. */
const pidOf = (identity: ServerIdentity) =>
  /^\d+$/.test(identity.pid) && Number(identity.pid) > 1 ? Number(identity.pid) : undefined;

/** A server whose configuration file is known, as a runtime that writes one needs. */
export type ConfiguredTmuxServer = TmuxServer & { readonly config: string };

/** One private tmux server, and the only way to run a tmux command. */
export class TmuxServer {
  readonly socket: string;
  /** The configuration file the server loads when a command starts it. */
  readonly config: string | undefined;

  private constructor(socket: string, config: string | undefined) {
    this.socket = socket;
    this.config = config;
  }

  /** The server at `socket`, which must lie inside `root`, a directory the caller made. */
  static at(socket: string, opts: { root: string; config: string }): ConfiguredTmuxServer;
  static at(socket: string, opts: { root: string; config?: string }): TmuxServer;
  static at(socket: string, opts: { root: string; config?: string }): TmuxServer {
    const uid = process.getuid?.() ?? 0;
    const lexical = socketRefusal(socket, opts.root, [], false);
    const refuse = (reason: string) => new RangeError(`refusing tmux socket ${socket}: ${reason}`);
    if (lexical !== undefined) throw refuse(lexical);
    const rootIssue = rootRefusal(opts.root, uid);
    if (rootIssue !== undefined) throw refuse(rootIssue);
    const root = realpathSync(opts.root);
    const resolved = join(root, relative(opts.root, socket));
    const shared = sharedDirs(uid, process.env["TMUX_TMPDIR"]);
    const reason = socketRefusal(resolved, root, shared, process.platform === "darwin");
    if (reason !== undefined) throw refuse(reason);
    return new TmuxServer(resolved, opts.config);
  }

  /**
   * The argv of a command on this server. `-u` because without a UTF-8 locale tmux prints a tab
   * in a format as `_`, and every column Bazhen reads back is tab-separated.
   */
  argv(...args: readonly string[]): [string, ...string[]] {
    const config = this.config === undefined ? [] : ["-f", this.config];
    return ["tmux", "-u", "-S", this.socket, ...config, ...args];
  }

  /** What the command printed; rejects as `execFile` does, with its stderr, or on its timeout. */
  async run(args: readonly string[], opts: TmuxOptions = {}): Promise<string> {
    const [bin, ...argv] = this.argv(...args);
    return new Promise((done, fail) => {
      const child = execFile(
        bin,
        argv,
        {
          env: opts.env,
          timeout: opts.timeout ?? TIMEOUT_MS,
          maxBuffer: opts.maxBytes ?? DEFAULT_MAX_BYTES,
          encoding: "utf8",
        },
        (err, stdout, stderr) => {
          const failed = settled(err, child, stdout, stderr);
          if (failed === null) done(stdout);
          else fail(failed);
        },
      );
    });
  }

  runSync(args: readonly string[], opts: TmuxOptions = {}): string {
    const [bin, ...argv] = this.argv(...args);
    return execFileSync(bin, argv, {
      env: opts.env,
      timeout: opts.timeout ?? TIMEOUT_MS,
      stdio: opts.stdio,
      maxBuffer: opts.maxBytes ?? DEFAULT_MAX_BYTES,
      encoding: "utf8",
    });
  }

  /** Whether the server answers; false for one that never started or has gone. */
  alive(): boolean {
    try {
      this.runSync(["list-sessions"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Sets and unsets variables in this server's global environment, which every new pane starts
   * from. The commands go to tmux's parser on stdin (`source-file -`), so no value ever appears in
   * argv; this is the only command that reaches tmux on stdin.
   */
  async setEnvironment(
    set: Readonly<Record<string, string>>,
    unset: readonly string[],
    opts: TmuxOptions = {},
  ): Promise<void> {
    const script = environmentScript(set, unset);
    if (script === "") return;
    const [bin, ...argv] = this.argv("source-file", "-");
    await new Promise<void>((done, fail) => {
      const child = execFile(
        bin,
        argv,
        { env: opts.env, timeout: opts.timeout ?? TIMEOUT_MS, encoding: "utf8" },
        (err, stdout, stderr) => {
          const failed = settled(err, child, stdout, stderr);
          if (failed === null) done();
          else fail(failed);
        },
      );
      child.stdin?.end(script);
    });
  }

  /**
   * What `ps` shows of the server `identity` names, whether or not the socket reaches it.
   * Sends nothing.
   */
  async verdict(identity: ServerIdentity): Promise<ServerVerdict> {
    const pid = pidOf(identity);
    if (pid === undefined) return { is: "unsure", why: `pid ${identity.pid} names no process` };
    return serverVerdict(await readProcess(pid), identity, this.socket);
  }

  /**
   * Makes the server `identity` names recreate its socket with `SIGUSR1`, once `ps` shows it still
   * runs as this socket's server: a temp cleaner can delete the socket under a live server
   * (foundation-design §7.1). Sends nothing unless it serves. Between the check and the signal a
   * pid could in principle be reused; macOS has no pidfd to close that window, and it would take
   * the server exiting and its pid going to a new process within the ~10 ms between them.
   */
  async recreateSocket(identity: ServerIdentity): Promise<ServerVerdict> {
    const verdict = await this.verdict(identity);
    const pid = pidOf(identity);
    if (verdict.is !== "serves" || pid === undefined) return verdict;
    return signalServer(vouchServer({ pid, socket: this.socket })) ? verdict : { is: "gone" };
  }

  /** Ends this server, if it runs. */
  kill(): void {
    try {
      this.runSync(["kill-server"], { stdio: "ignore" });
    } catch {
      // Never started, or already gone.
    }
  }

  /**
   * The process group of `pane` (a `%id`), for `signalPane`, once this server confirms the pane
   * still runs the process `expected` names. A dead pane keeps its pid readable, and that pid may
   * by now be another process's.
   */
  async paneGroup(pane: string, expected: PaneProcess, opts: TmuxOptions = {}): Promise<PaneGroup> {
    const format = `#{pane_dead}\t#{pane_pid}\t#{${GENERATION_OPTION}}`;
    const out = await this.run(["display-message", "-p", "-t", pane, format], opts);
    const [dead, pid, generation] = out.trim().split("\t");
    if (dead !== "0") throw new PaneRefused(pane, "dead");
    if (pid !== expected.pid || generation !== expected.generation) {
      throw new PaneRefused(pane, "process-replaced");
    }
    return vouch({ pid: Number(pid), server: this.socket, pane, generation });
  }
}

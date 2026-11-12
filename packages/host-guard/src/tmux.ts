// The one module that runs tmux. Every command names its server by socket path, inside a
// directory its caller owns, and never by `-L` name: a name resolves in the directory the
// user's own servers share, and one wrong socket ends every tmux session on the machine.

import { execFile, execFileSync, type StdioOptions } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { vouch, type PaneGroup } from "./signal.ts";

const run = promisify(execFile);
const TIMEOUT_MS = 5_000;

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
}

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

  /** What the command printed; rejects as `execFile` does, with its stderr. */
  async run(args: readonly string[], opts: TmuxOptions = {}): Promise<string> {
    const [bin, ...argv] = this.argv(...args);
    const { stdout } = await run(bin, argv, { env: opts.env, timeout: opts.timeout ?? TIMEOUT_MS });
    return stdout;
  }

  runSync(args: readonly string[], opts: TmuxOptions = {}): string {
    const [bin, ...argv] = this.argv(...args);
    return execFileSync(bin, argv, {
      env: opts.env,
      timeout: opts.timeout ?? TIMEOUT_MS,
      stdio: opts.stdio,
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

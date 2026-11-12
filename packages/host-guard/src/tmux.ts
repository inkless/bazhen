// The one module that runs tmux. Every command names its server by socket path, inside a
// directory its caller owns, and never by `-L` name: a name resolves in the directory the
// user's own servers share, and one wrong socket ends every tmux session on the machine.

import { execFile, execFileSync, type StdioOptions } from "node:child_process";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { vouch, type PaneGroup } from "./signal.ts";

const run = promisify(execFile);
const TIMEOUT_MS = 5_000;

/** Where tmux keeps the servers it finds by name. No root may contain one. */
const sharedDirs = (uid: number) => ["/tmp", "/private/tmp"].map((dir) => `${dir}/tmux-${uid}`);

const within = (dir: string, path: string) => {
  const rel = relative(dir, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
};
const normalized = (path: string) => isAbsolute(path) && resolve(path) === path;

/** Why `socket` may not be used under `root`, or undefined when it may. */
export function socketRefusal(socket: string, root: string, uid: number): string | undefined {
  if (!normalized(root)) return `its root ${root} is not an absolute, normalized path`;
  if (!normalized(socket)) return "it is not an absolute, normalized path";
  if (socket === root || !within(root, socket)) return `it is not inside ${root}`;
  if (basename(socket) === "default") return "`default` names the user's own server";
  if (sharedDirs(uid).some((dir) => within(root, dir) || within(dir, socket))) {
    return "its root holds the directory where the user's own servers live";
  }
  return undefined;
}

/** `[major, minor]` of the installed tmux, from `tmux 3.6b` or `tmux next-3.9`. No server runs. */
export function tmuxVersion(): [number, number] {
  const out = execFileSync("tmux", ["-V"], { encoding: "utf8", timeout: TIMEOUT_MS }).trim();
  const match = /^tmux (?:next-)?(\d+)\.(\d+)/.exec(out);
  if (match === null) throw new Error(`Unrecognised tmux version: ${out}`);
  return [Number(match[1]), Number(match[2])];
}

export interface TmuxOptions {
  /** The whole environment of the command; a server it starts copies it into every pane. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeout?: number;
  readonly stdio?: StdioOptions;
}

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
  static at(socket: string, opts: { root: string; config?: string }): TmuxServer {
    const reason = socketRefusal(socket, opts.root, process.getuid?.() ?? 0);
    if (reason !== undefined) throw new RangeError(`refusing tmux socket ${socket}: ${reason}`);
    return new TmuxServer(socket, opts.config);
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

  /** The process group of `pane` (a `%id`), as this server reports it, for `signalPane`. */
  async paneGroup(pane: string, opts: TmuxOptions = {}): Promise<PaneGroup> {
    const out = await this.run(["display-message", "-p", "-t", pane, "#{pane_pid}"], opts);
    return vouch(Number(out.trim()));
  }
}

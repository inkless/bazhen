import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { promisify } from "node:util";
import type {
  PtySpawner,
  RuntimeAdapter,
  RuntimeHealth,
  RuntimeInventoryEntry,
  RuntimeRef,
  RuntimeStream,
  Size,
  TerminalId,
  TerminalSpec,
} from "@bazhen/core";
import { isId } from "@bazhen/core";

const run = promisify(execFile);
const TAG = "@bazhen_terminal_id";
const TMUX_TIMEOUT_MS = 5_000;

/**
 * The private server's configuration. With tmux's defaults, Ctrl-B would be swallowed as a prefix
 * and `C-b d` would detach Bazhen's own client, so no key reaches tmux itself. `window-size
 * manual` is deliberately absent: set globally, tmux before 3.8 crashes on the next window creation.
 */
export const TMUX_CONFIG = `set -g prefix None
set -g prefix2 None
unbind-key -a -T prefix
unbind-key -a -T root
unbind-key -a -T copy-mode
unbind-key -a -T copy-mode-vi
set -g status off
set -g remain-on-exit on
set -g escape-time 0
set -g default-terminal tmux-256color
set -g extended-keys on
set -g focus-events on
set -g set-clipboard on
set -as terminal-features ",xterm-256color:RGB:extkeys:clipboard:hyperlinks:focus"
`;

export interface TmuxRuntimeOptions {
  /** Private server name for `tmux -L`. Bazhen never touches any other server. */
  readonly socket: string;
  readonly pty: PtySpawner;
  /** Where TMUX_CONFIG is written before the server starts. */
  readonly configFile: string;
  readonly tmuxBin?: string;
}

export class TmuxRuntime implements RuntimeAdapter {
  readonly kind = "tmux";
  private readonly bin: string;
  private readonly opts: TmuxRuntimeOptions;

  constructor(opts: TmuxRuntimeOptions) {
    this.opts = opts;
    this.bin = opts.tmuxBin ?? "tmux";
    writeFileSync(opts.configFile, TMUX_CONFIG, { mode: 0o600 });
  }

  private async tmux(...args: string[]): Promise<string> {
    const { stdout } = await run(
      this.bin,
      ["-L", this.opts.socket, "-f", this.opts.configFile, ...args],
      {
        timeout: TMUX_TIMEOUT_MS,
      },
    );
    return stdout.trimEnd();
  }

  async health(): Promise<RuntimeHealth> {
    let version: string | null = null;
    try {
      version = (await run(this.bin, ["-V"], { timeout: TMUX_TIMEOUT_MS })).stdout.trim();
    } catch {
      return { state: "unreachable", version: null };
    }
    try {
      await this.tmux("list-sessions", "-F", "#{session_id}");
      return { state: "healthy", version };
    } catch (err) {
      const message = stderrOf(err);
      if (/no server running|error connecting/.test(message))
        return { state: "not-running", version };
      return { state: "unreachable", version };
    }
  }

  async create(spec: TerminalSpec): Promise<RuntimeRef> {
    const session = sessionName(spec.terminalId);
    const env = Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
    const window = `${session}:0`;
    const { cols, rows } = spec.size;
    await this.tmux(
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      String(cols),
      "-y",
      String(rows),
      "-c",
      spec.cwd,
      ...env,
      "--",
      ...spec.argv.map(escapeTrailingSemicolon),
    );
    await this.tmux("set-option", "-t", session, TAG, spec.terminalId);
    await this.tmux("set-option", "-w", "-t", window, "window-size", "manual");
    await this.tmux("resize-window", "-t", window, "-x", String(cols), "-y", String(rows));
    const locator = await this.locate(session);
    return { terminalId: spec.terminalId, runtime: this.kind, locator };
  }

  private async locate(session: string): Promise<Record<string, string>> {
    const fmt = "#{pid}\t#{start_time}\t#{session_id}\t#{pane_id}";
    const [pid = "", start = "", sessionId = "", paneId = ""] = (
      await this.tmux("display-message", "-p", "-t", `${session}:0`, fmt)
    ).split("\t");
    return {
      socket: this.opts.socket,
      session,
      serverPid: pid,
      serverStart: start,
      sessionId,
      paneId,
    };
  }

  async inventory(): Promise<RuntimeInventoryEntry[]> {
    const out = await this.tmux(
      "list-panes",
      "-a",
      "-F",
      `#{${TAG}}\t#{session_name}\t#{pane_dead}\t#{pane_dead_status}`,
    );
    const entries: RuntimeInventoryEntry[] = [];
    for (const line of out.split("\n")) {
      const [terminalId = "", session = "", dead = "0", status = ""] = line.split("\t");
      if (!isId("term", terminalId)) continue;
      entries.push({
        ref: { terminalId, runtime: this.kind, locator: await this.locate(session) },
        dead: dead === "1",
        exitStatus: dead === "1" && status !== "" ? Number(status) : null,
      });
    }
    return entries;
  }

  async attach(ref: RuntimeRef, size: Size): Promise<RuntimeStream> {
    const session = ref.locator.session ?? sessionName(ref.terminalId);
    await this.tmux(
      "resize-window",
      "-t",
      `${session}:0`,
      "-x",
      String(size.cols),
      "-y",
      String(size.rows),
    );
    const proc = this.opts.pty.spawn(
      [this.bin, "-L", this.opts.socket, "attach-session", "-t", session],
      size,
      {},
    );
    const closeHandlers: Array<() => void> = [];
    let closed = false;
    proc.onExit(() => {
      closed = true;
      for (const h of closeHandlers) h();
    });
    return {
      onData: (cb) => proc.onData(cb),
      onClose: (cb) => {
        if (closed) cb();
        else closeHandlers.push(cb);
      },
      write: (bytes) => proc.write(bytes),
      resize: (next) => {
        proc.resize(next);
        this.tmux(
          "resize-window",
          "-t",
          `${session}:0`,
          "-x",
          String(next.cols),
          "-y",
          String(next.rows),
        ).catch(() => {});
      },
      close: () => proc.kill(),
    };
  }

  async close(ref: RuntimeRef): Promise<void> {
    await this.tmux("kill-session", "-t", ref.locator.session ?? sessionName(ref.terminalId));
  }
}

/** tmux reads an argument ending in `;` as a command separator and drops the `;`. */
export function escapeTrailingSemicolon(arg: string): string {
  return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
}

function stderrOf(err: unknown): string {
  if (typeof err === "object" && err !== null && "stderr" in err) return String(err.stderr);
  return String(err);
}

export function sessionName(terminalId: TerminalId): string {
  return `bz-${terminalId.slice(-12)}`;
}

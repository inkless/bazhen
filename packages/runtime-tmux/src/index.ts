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
  TerminalTags,
} from "@bazhen/core";
import { isId } from "@bazhen/core";

const run = promisify(execFile);
const TMUX_TIMEOUT_MS = 5_000;

/** Bazhen's tmux user options, in the order `list-panes` reports them. */
const TAGS = [
  ["terminalId", "@bazhen_terminal_id"],
  ["kind", "@bazhen_kind"],
  ["agentId", "@bazhen_agent_id"],
  ["linkedAgentId", "@bazhen_linked_agent_id"],
] as const;

/** Where a pane is, read in the same `list-panes` or `display-message` call as its tags. */
const LOCATION = ["session_name", "pid", "start_time", "session_id", "pane_id"] as const;

/**
 * The private server's configuration. With tmux's defaults, Ctrl-B would be swallowed as a prefix
 * and `C-b d` would detach Bazhen's own client, so no key reaches tmux itself. `window-size
 * manual` is deliberately absent: set globally, tmux before 3.8 crashes on the next window
 * creation. An empty `update-environment` stops an attaching client from copying its own
 * variables into a session.
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
set -g update-environment ""
set -as terminal-features ",xterm-256color:RGB:extkeys:clipboard:hyperlinks:focus"
`;

export class TmuxError extends Error {
  readonly args: readonly string[];
  readonly stderr: string;

  constructor(args: readonly string[], cause: unknown) {
    const raw: unknown =
      typeof cause === "object" && cause !== null ? Reflect.get(cause, "stderr") : "";
    const stderr = typeof raw === "string" ? raw.trim() : "";
    super(`tmux ${args.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, { cause });
    this.args = args;
    this.stderr = stderr;
  }
}

export interface TmuxRuntimeOptions {
  /** Private server name for `tmux -L`. Bazhen never touches any other server. */
  readonly socket: string;
  readonly pty: PtySpawner;
  /** Where TMUX_CONFIG is written before the server starts. */
  readonly configFile: string;
  /**
   * The whole environment of every tmux command and of the daemon's attach clients. The server
   * copies it into every pane, so it must already be filtered (foundation-design §9.5).
   */
  readonly env: Readonly<Record<string, string>>;
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
    const argv = ["-L", this.opts.socket, "-f", this.opts.configFile, ...args];
    try {
      const { stdout } = await run(this.bin, argv, {
        env: this.opts.env,
        timeout: TMUX_TIMEOUT_MS,
      });
      return stdout.trimEnd();
    } catch (cause) {
      throw new TmuxError(args, cause);
    }
  }

  async health(): Promise<RuntimeHealth> {
    let version: string;
    try {
      version = await this.tmux("-V");
    } catch {
      return { state: "unreachable", version: null };
    }
    try {
      await this.tmux("list-sessions", "-F", "#{session_id}");
      return { state: "healthy", version };
    } catch (err) {
      if (!(err instanceof TmuxError)) throw err;
      const notRunning = /no server running|error connecting/.test(err.stderr);
      return { state: notRunning ? "not-running" : "unreachable", version };
    }
  }

  async create(spec: TerminalSpec): Promise<RuntimeRef> {
    const session = sessionName(spec.terminalId);
    const env = Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
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
    const location = await this.tmux(
      ...sequence([
        ...tagCommands(session, { terminalId: spec.terminalId, ...spec.tags }),
        ["set-option", "-w", "-t", windowOf(session), "window-size", "manual"],
        resizeArgs(session, spec.size),
        ["display-message", "-p", "-t", windowOf(session), format(LOCATION)],
      ]),
    );
    return {
      terminalId: spec.terminalId,
      runtime: this.kind,
      locator: this.locator(location.split("\t")),
    };
  }

  private locator([session = "", pid = "", start = "", sessionId = "", paneId = ""]: string[]) {
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
    const fields = [
      ...TAGS.map(([, option]) => option),
      ...LOCATION,
      "pane_dead",
      "pane_dead_status",
    ];
    const out = await this.tmux("list-panes", "-a", "-F", format(fields));
    return out.split("\n").flatMap((line) => {
      const values = line.split("\t");
      const tagged = decodeTags(values.slice(0, TAGS.length));
      if (tagged === null) return [];
      const [dead, status] = values.slice(TAGS.length + LOCATION.length);
      const { terminalId, ...tags } = tagged;
      return [
        {
          ref: { terminalId, runtime: this.kind, locator: this.locator(values.slice(TAGS.length)) },
          tags,
          dead: dead === "1",
          exitStatus: dead === "1" && status !== "" ? Number(status) : null,
        },
      ];
    });
  }

  async attach(ref: RuntimeRef, size: Size): Promise<RuntimeStream> {
    const session = ref.locator.session ?? sessionName(ref.terminalId);
    const resizeWindow = (next: Size) => this.tmux(...resizeArgs(session, next));
    await resizeWindow(size);
    const proc = this.opts.pty.spawn(
      [this.bin, "-L", this.opts.socket, "attach-session", "-t", session],
      size,
      this.opts.env,
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
      resize: async (next) => {
        proc.resize(next);
        await resizeWindow(next);
      },
      close: () => proc.kill(),
    };
  }

  async close(ref: RuntimeRef): Promise<void> {
    await this.tmux("kill-session", "-t", ref.locator.session ?? sessionName(ref.terminalId));
  }
}

type Tagged = { readonly terminalId: TerminalId } & TerminalTags;

function tagCommands(session: string, tagged: Tagged): string[][] {
  return TAGS.flatMap(([key, option]) => {
    const value = tagged[key];
    return value === undefined ? [] : [["set-option", "-t", session, option, value]];
  });
}

/** The tags `tagCommands` wrote, or null for a pane Bazhen did not create. */
function decodeTags([terminalId = "", kind, agentId = "", linked = ""]: string[]): Tagged | null {
  if (!isId("term", terminalId) || (kind !== "agent" && kind !== "shell")) return null;
  return {
    terminalId,
    kind,
    ...(isId("agent", agentId) ? { agentId } : {}),
    ...(isId("agent", linked) ? { linkedAgentId: linked } : {}),
  };
}

const windowOf = (session: string) => `${session}:0`;

const resizeArgs = (session: string, size: Size) => [
  "resize-window",
  "-t",
  windowOf(session),
  "-x",
  String(size.cols),
  "-y",
  String(size.rows),
];

const format = (fields: readonly string[]) => fields.map((f) => `#{${f}}`).join("\t");

/** Several tmux commands as one invocation: a lone `;` argument separates them. */
function sequence(commands: string[][]): string[] {
  return commands.flatMap((command, i) => (i === 0 ? command : [";", ...command]));
}

/** tmux reads an argument ending in `;` as a command separator and drops the `;`. */
export function escapeTrailingSemicolon(arg: string): string {
  return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
}

export function sessionName(terminalId: TerminalId): string {
  return `bz-${terminalId.slice(-12)}`;
}

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

/** Every pane fact Bazhen reads from tmux, by name: its own @bazhen_* options, then tmux's. */
const COLUMN = {
  terminalId: "@bazhen_terminal_id",
  kind: "@bazhen_kind",
  agentId: "@bazhen_agent_id",
  linkedAgentId: "@bazhen_linked_agent_id",
  session: "session_name",
  serverPid: "pid",
  serverStart: "start_time",
  sessionId: "session_id",
  paneId: "pane_id",
  dead: "pane_dead",
  status: "pane_dead_status",
} as const;
type Column = keyof typeof COLUMN;
type Row = (column: Column) => string;

/** A tmux format for `keys`, and a parser that reads a printed line back by column name. */
function columns(keys: readonly Column[]) {
  return {
    format: keys.map((k) => `#{${COLUMN[k]}}`).join("\t"),
    parse: (line: string): Row => {
      const values = line.split("\t");
      return (k) => values[keys.indexOf(k)] ?? "";
    },
  };
}

const LOCATION_KEYS = ["session", "serverPid", "serverStart", "sessionId", "paneId"] as const;
const LOCATION = columns(LOCATION_KEYS);
const PANE = columns([
  "terminalId",
  "kind",
  "agentId",
  "linkedAgentId",
  ...LOCATION_KEYS,
  "dead",
  "status",
]);

/**
 * The private server's configuration. With tmux's defaults, Ctrl-B would be swallowed as a prefix
 * and `C-b d` would detach Bazhen's own client, so no key reaches tmux itself. `window-size
 * manual` is deliberately absent: set globally, tmux before 3.8 crashes on the next window
 * creation. An empty `update-environment` stops an attaching client from copying its own
 * variables into a session. Without the smcup override, the client switches the browser's
 * terminal to its alternate buffer, which keeps no scrollback and turns the wheel into arrow keys.
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
set -ga terminal-overrides ",xterm-256color:smcup@:rmcup@"
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
      return { state: noServer(err) ? "not-running" : "unreachable", version };
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
        ...tagCommands(session, spec.terminalId, spec.tags),
        ["set-option", "-w", "-t", windowOf(session), "window-size", "manual"],
        resizeArgs(session, spec.size),
        ["display-message", "-p", "-t", windowOf(session), LOCATION.format],
      ]),
    );
    return {
      terminalId: spec.terminalId,
      runtime: this.kind,
      locator: this.locator(LOCATION.parse(location)),
    };
  }

  private locator(row: Row): Record<string, string> {
    return {
      socket: this.opts.socket,
      ...Object.fromEntries(LOCATION_KEYS.map((k) => [k, row(k)])),
    };
  }

  async inventory(): Promise<RuntimeInventoryEntry[]> {
    const out = await this.tmux("list-panes", "-a", "-F", PANE.format);
    return out.split("\n").flatMap((line) => {
      const row = PANE.parse(line);
      const tagged = decodeTags(row);
      if (tagged === null) return [];
      const dead = row("dead") === "1";
      return [
        {
          ref: { terminalId: tagged.terminalId, runtime: this.kind, locator: this.locator(row) },
          tags: tagged.tags,
          dead,
          exitStatus: dead && row("status") !== "" ? Number(row("status")) : null,
        },
      ];
    });
  }

  async attach(ref: RuntimeRef, size: Size | null): Promise<RuntimeStream> {
    const session = sessionOf(ref);
    const resizeWindow = (next: Size) => this.tmux(...resizeArgs(session, next));
    if (size !== null) await resizeWindow(size);
    const [cols = 80, rows = 24] = (
      await this.tmux(
        "display-message",
        "-p",
        "-t",
        windowOf(session),
        "#{window_width} #{window_height}",
      )
    )
      .split(" ")
      .map(Number);
    const proc = this.opts.pty.spawn(
      [this.bin, "-L", this.opts.socket, "attach-session", "-t", session],
      { cols, rows },
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
      // The window first: once its session is gone, the failure is tmux's to report.
      resize: async (next) => {
        await resizeWindow(next);
        proc.resize(next);
      },
      close: () => proc.kill(),
    };
  }

  async snapshot(ref: RuntimeRef): Promise<string> {
    const window = windowOf(sessionOf(ref));
    const out = await this.tmux(
      ...sequence([
        ["capture-pane", "-p", "-e", "-t", window],
        ["display-message", "-p", "-t", window, "#{cursor_x} #{cursor_y}"],
      ]),
    );
    const lines = out.split("\n");
    const [x = 0, y = 0] = (lines.pop() ?? "").split(" ").map(Number);
    // Clear, draw the screen line by line, then put the cursor back where the program left it.
    return `\x1b[H\x1b[2J${lines.join("\r\n")}\x1b[${y + 1};${x + 1}H`;
  }

  async close(ref: RuntimeRef): Promise<void> {
    await this.tmux("kill-session", "-t", sessionOf(ref));
  }
}

function tagCommands(session: string, terminalId: TerminalId, tags: TerminalTags): string[][] {
  const options: [string, string][] = [
    [COLUMN.terminalId, terminalId],
    [COLUMN.kind, tags.kind],
  ];
  if (tags.kind === "agent") options.push([COLUMN.agentId, tags.agentId]);
  else if (tags.linkedAgentId) options.push([COLUMN.linkedAgentId, tags.linkedAgentId]);
  return options.map(([option, value]) => ["set-option", "-t", session, option, value]);
}

/** The tags `tagCommands` wrote, or null for a pane whose tags Bazhen did not write. */
function decodeTags(row: Row): { terminalId: TerminalId; tags: TerminalTags } | null {
  const terminalId = row("terminalId");
  const agentId = row("agentId");
  const linked = row("linkedAgentId");
  if (!isId("term", terminalId)) return null;
  if (row("kind") === "agent") {
    return isId("agent", agentId) ? { terminalId, tags: { kind: "agent", agentId } } : null;
  }
  if (row("kind") !== "shell") return null;
  return {
    terminalId,
    tags: isId("agent", linked) ? { kind: "shell", linkedAgentId: linked } : { kind: "shell" },
  };
}

/** tmux's answer when its server isn't running, or its socket is gone. */
const noServer = (err: TmuxError) => /no server running|error connecting/.test(err.stderr);

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

/** Several tmux commands as one invocation: a lone `;` argument separates them. */
function sequence(commands: string[][]): string[] {
  return commands.flatMap((command, i) => (i === 0 ? command : [";", ...command]));
}

/** tmux reads an argument ending in `;` as a command separator and drops the `;`. */
export function escapeTrailingSemicolon(arg: string): string {
  return arg.endsWith(";") ? `${arg.slice(0, -1)}\\;` : arg;
}

const sessionOf = (ref: RuntimeRef) => ref.locator.session ?? sessionName(ref.terminalId);

export function sessionName(terminalId: TerminalId): string {
  return `bz-${terminalId.slice(-12)}`;
}

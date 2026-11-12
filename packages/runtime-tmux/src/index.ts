import { execFile } from "node:child_process";
import { writeFileSync } from "node:fs";
import { constants } from "node:os";
import { promisify } from "node:util";
import type {
  Attached,
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
import type { ExitStatus, Signal } from "@bazhen/protocol";
import { isId, ProcessState, StaleIncarnation } from "@bazhen/core";
import { ExitWatch, type DeadTerminal } from "./exit-watch.ts";

const run = promisify(execFile);
const TMUX_TIMEOUT_MS = 5_000;
const EXIT_POLL_MS = 1_000;

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
  panePid: "pane_pid",
  dead: "pane_dead",
  status: "pane_dead_status",
  deadSignal: "pane_dead_signal",
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

const LOCATION_KEYS = [
  "session",
  "serverPid",
  "serverStart",
  "sessionId",
  "paneId",
  "panePid",
] as const;
const LOCATION = columns(LOCATION_KEYS);
const PANE = columns([
  "terminalId",
  "kind",
  "agentId",
  "linkedAgentId",
  ...LOCATION_KEYS,
  "dead",
  "status",
  "deadSignal",
]);
const SERVER = columns(["serverPid", "serverStart"]);

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
  /** How often dead terminals are looked for while anyone listens. */
  readonly exitPollMs?: number;
}

export class TmuxRuntime implements RuntimeAdapter {
  readonly kind = "tmux";
  private readonly bin: string;
  private readonly opts: TmuxRuntimeOptions;
  private readonly exits: ExitWatch;

  constructor(opts: TmuxRuntimeOptions) {
    this.opts = opts;
    this.bin = opts.tmuxBin ?? "tmux";
    this.exits = new ExitWatch(() => this.deadTerminals(), opts.exitPollMs ?? EXIT_POLL_MS);
    writeFileSync(opts.configFile, TMUX_CONFIG, { mode: 0o600 });
  }

  private async tmux(...args: string[]): Promise<string> {
    return (await this.tmuxOutput(args)).trimEnd();
  }

  /** What tmux printed, untrimmed: blank lines at its end can be content. */
  private async tmuxOutput(args: readonly string[]): Promise<string> {
    const argv = ["-L", this.opts.socket, "-f", this.opts.configFile, ...args];
    try {
      const { stdout } = await run(this.bin, argv, {
        env: this.opts.env,
        timeout: TMUX_TIMEOUT_MS,
      });
      return stdout;
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
      ...processArgs(spec),
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
          exit: dead ? exitOf(row) : null,
        },
      ];
    });
  }

  async attach(ref: RuntimeRef, size: Size | null, historyLines: number): Promise<Attached> {
    const session = sessionOf(ref);
    const resizeWindow = (next: Size) => this.tmux(...resizeArgs(session, next));
    if (size !== null) await resizeWindow(size);
    const [cols = 80, rows = 24, held = 0, alternate = 0] = (
      await this.tmux(
        "display-message",
        "-p",
        "-t",
        windowOf(session),
        "#{window_width} #{window_height} #{history_size} #{alternate_on}",
      )
    )
      .split(" ")
      .map(Number);
    // A program on its alternate screen has no history of its own: tmux's is the main screen's,
    // behind it. With no history, `-E -1` would capture the screen's first line instead.
    const lines = alternate === 1 ? 0 : Math.min(historyLines, held);
    const history =
      lines > 0
        ? (
            await this.tmuxOutput([
              "capture-pane",
              "-p",
              "-e",
              "-J",
              "-t",
              windowOf(session),
              "-S",
              `-${lines}`,
              "-E",
              "-1",
            ])
          ).replace(/\n$/, "")
        : "";
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
    const stream: RuntimeStream = {
      size: { cols, rows },
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
    return { stream, history };
  }

  async close(ref: RuntimeRef): Promise<void> {
    const [pane] = await this.panesOf(ref);
    if (pane !== undefined) await this.tmux("kill-session", "-t", located(pane.ref, "sessionId"));
  }

  async respawn(ref: RuntimeRef, spec: TerminalSpec): Promise<RuntimeRef> {
    const pane = await this.paneOf(ref);
    if (pane.exit === null) throw new ProcessState(ref.terminalId, "exited");
    const target = located(pane.ref, "paneId");
    const location = await this.tmux(
      ...sequence([
        ["respawn-pane", "-t", target, ...processArgs(spec)],
        ["display-message", "-p", "-t", target, LOCATION.format],
      ]),
    );
    return { ...ref, locator: this.locator(LOCATION.parse(location)) };
  }

  async signal(ref: RuntimeRef, signal: Signal): Promise<void> {
    const pane = await this.paneOf(ref);
    if (pane.exit !== null) throw new ProcessState(ref.terminalId, "running");
    const pid = pane.ref.locator.panePid;
    if (pid !== ref.locator.panePid) throw new StaleIncarnation(ref.terminalId, "process-replaced");
    // The pane's process leads its own group, so this reaches the tools it started as well,
    // as Ctrl-C or a hangup in a terminal would.
    try {
      process.kill(-Number(pid), signal);
    } catch (err) {
      // The group exited after the check above; reporting that exit is the poller's job.
      if (!(err instanceof Error && "code" in err && err.code === "ESRCH")) throw err;
    }
  }

  onExit(cb: (ref: RuntimeRef, status: ExitStatus) => void): () => void {
    return this.exits.subscribe(cb);
  }

  private async deadTerminals(): Promise<DeadTerminal[]> {
    try {
      return (await this.inventory()).flatMap((e) =>
        e.exit === null ? [] : [{ ref: e.ref, status: e.exit }],
      );
    } catch (err) {
      // An unreadable server is no evidence that anything exited (foundation-design §7.1).
      if (err instanceof TmuxError) return [];
      throw err;
    }
  }

  /**
   * The panes tagged with `ref`'s terminal, read from the server `ref` was created on. tmux reuses
   * its session and pane numbers after a restart, so a number alone could name another agent's
   * terminal. Empty means the server answered and has no such terminal.
   */
  private async panesOf(ref: RuntimeRef): Promise<RuntimeInventoryEntry[]> {
    const panes = (await this.inventory()).filter((e) => e.ref.terminalId === ref.terminalId);
    const server = panes[0]?.ref.locator ?? (await this.server());
    if (
      server.serverPid !== ref.locator.serverPid ||
      server.serverStart !== ref.locator.serverStart
    )
      throw new StaleIncarnation(ref.terminalId, "server-replaced");
    return panes;
  }

  private async server(): Promise<Record<string, string>> {
    const row = SERVER.parse(await this.tmux("display-message", "-p", SERVER.format));
    return { serverPid: row("serverPid"), serverStart: row("serverStart") };
  }

  /** The pane `ref` recorded: respawn and signal act on it and on nothing else. */
  private async paneOf(ref: RuntimeRef): Promise<RuntimeInventoryEntry> {
    const panes = await this.panesOf(ref);
    const pane = panes.find((e) => e.ref.locator.paneId === ref.locator.paneId);
    if (pane === undefined)
      throw new StaleIncarnation(ref.terminalId, panes.length > 0 ? "pane-replaced" : "gone");
    return pane;
  }
}

/**
 * A field of a ref read back from tmux. An empty `-t` would let tmux pick its own default
 * target, which could be another agent's terminal, so a missing field is never defaulted.
 */
function located(ref: RuntimeRef, key: "sessionId" | "paneId"): string {
  const value = ref.locator[key];
  if (!value) throw new Error(`terminal ${ref.terminalId} has no ${key} in its locator`);
  return value;
}

/**
 * The process half of a terminal: its directory, Bazhen's variables and its argv. tmux sets TMUX
 * and TMUX_PANE in every pane, whatever the server's environment, and with them a terminal's
 * `tmux kill-server` would end Bazhen's private server and every terminal on it. A new terminal
 * tab has neither, so `env` drops them and then execs the argv, which stays the pane's process.
 */
const processArgs = (spec: TerminalSpec) => [
  "-c",
  spec.cwd,
  ...Object.entries(spec.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
  "--",
  "env",
  "-u",
  "TMUX",
  "-u",
  "TMUX_PANE",
  "--",
  ...spec.argv.map(escapeTrailingSemicolon),
];

const SIGNAL_NAMES = new Map(Object.entries(constants.signals).map(([name, n]) => [n, name]));

/** tmux leaves the status empty for a signalled process, and names the signal by platform. */
function exitOf(row: Row): ExitStatus {
  const status = row("status");
  const raw = row("deadSignal");
  const signal = /^\d+$/.test(raw)
    ? (SIGNAL_NAMES.get(Number(raw)) ?? raw)
    : `SIG${raw.toUpperCase().replace(/^SIG/, "")}`;
  return { code: status === "" ? null : Number(status), signal: raw === "" ? null : signal };
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

/** The socket is missing or nobody listens on it; any other failure says nothing about the server. */
const noServer = (err: TmuxError) =>
  /no server running|error connecting to .* \((No such file or directory|Connection refused)\)/.test(
    err.stderr,
  );

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

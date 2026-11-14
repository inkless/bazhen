import { writeFileSync } from "node:fs";
import type {
  HistoryAttached,
  Foreground,
  TerminalForeground,
  ProcessSpec,
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
import {
  HISTORY_LINES,
  TERMINAL_COLOURS,
  type ExitStatus,
  type Signal,
  type TuiTheme,
} from "@bazhen/protocol";
import {
  GENERATION_OPTION,
  PaneRefused,
  isSafeEnvEntry,
  signalPane,
  terminalGroups,
  terminalForeground,
  type ConfiguredTmuxServer,
  type ServerIdentity,
} from "@bazhen/host-guard";
import {
  assertSameGeneration,
  isId,
  ProcessState,
  StaleIncarnation,
  TerminalUnconfirmed,
} from "@bazhen/core";
import { exitStatus, UnknownCause } from "./exit-status.ts";
import { redacted } from "./redact.ts";
import { shellCommand } from "./shell.ts";

export { shellCommand };
import { ExitWatch, type DeadTerminal } from "./exit-watch.ts";
import { ScreenWatch } from "./screen-watch.ts";

const EXIT_POLL_MS = 1_000;
const UNKNOWN_EXIT_AFTER_MS = 2_000;
/** How long output must pause, or at most how long it may run, before the screen is re-read. */
const SCREEN_QUIET_MS = 100;
const SCREEN_MAX_WAIT_MS = 500;

/** Every pane fact Bazhen reads from tmux, by name: its own @bazhen_* options, then tmux's. */
const COLUMN = {
  terminalId: "@bazhen_terminal_id",
  kind: "@bazhen_kind",
  agentId: "@bazhen_agent_id",
  linkedAgentId: "@bazhen_linked_agent_id",
  harnessSession: "@bazhen_harness_session",
  session: "session_name",
  serverPid: "pid",
  serverStart: "start_time",
  sessionId: "session_id",
  paneId: "pane_id",
  panePid: "pane_pid",
  generation: GENERATION_OPTION,
  dead: "pane_dead",
  status: "pane_dead_status",
  deadSignal: "pane_dead_signal",
  currentCommand: "pane_current_command",
  currentPath: "pane_current_path",
} as const;
type Column = keyof typeof COLUMN;
type Row = (column: Column) => string;

/** A tmux format for `keys`, and a parser that reads a printed line back by column name. */
function columns(keys: readonly Column[]) {
  return {
    width: keys.length,
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
  "generation",
] as const;
const LOCATION = columns(LOCATION_KEYS);
const PANE = columns([
  "terminalId",
  "kind",
  "agentId",
  "linkedAgentId",
  "harnessSession",
  ...LOCATION_KEYS,
  "dead",
  "status",
  "deadSignal",
]);
const SERVER = columns(["serverPid", "serverStart"]);
const FOREGROUND = columns([
  "terminalId",
  "kind",
  "agentId",
  "linkedAgentId",
  "harnessSession",
  ...LOCATION_KEYS,
  "dead",
  "currentCommand",
  "currentPath",
]);

/**
 * The most a history capture may print, whatever its size: well past Node's own 1 MiB limit,
 * which a full history of long lines passes, and short of copying hundreds of megabytes.
 */
const CAPTURE_MAX_BYTES = 64 * 1024 * 1024;

/** The command printed more than it was allowed to. */
const overflowed = (err: unknown) =>
  err instanceof TmuxError &&
  Reflect.get(Object(err.cause), "code") === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";

/**
 * The only keys tmux itself takes: they leave a mode, which no key enters. Without them a pane
 * that a `run-shell` printed into stays in view mode with every key ignored.
 */
const MODE_EXIT_BINDINGS = ["copy-mode", "copy-mode-vi"].flatMap((table) =>
  ["q", "Escape", "C-c"].map((key) => ["bind-key", "-T", table, key, "send-keys", "-X", "cancel"]),
);

/**
 * The private server's configuration. With tmux's defaults, Ctrl-B would be swallowed as a prefix
 * and `C-b d` would detach Bazhen's own client, so no key reaches tmux itself outside a mode.
 * `window-size manual` is deliberately absent: set globally, tmux before 3.8 crashes on the next
 * window creation. An empty `update-environment` stops an attaching client from copying its own
 * variables into a session. `history-limit` keeps as much history as the daemon and each view
 * do. Without the smcup override, the client switches the browser's terminal to its alternate
 * buffer, which keeps no scrollback and turns the wheel into arrow keys.
 */
export const TMUX_CONFIG = `set -g prefix None
set -g prefix2 None
unbind-key -a -T prefix
unbind-key -a -T root
unbind-key -a -T copy-mode
unbind-key -a -T copy-mode-vi
${MODE_EXIT_BINDINGS.map((command) => command.join(" ")).join("\n")}
set -g status off
set -g history-limit ${HISTORY_LINES}
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
  /** The command as a log may show it: values the user's own text could be in are redacted. */
  readonly args: readonly string[];
  readonly stderr: string;
  /**
   * tmux exited with a status of its own. A client its timeout stopped exits with a status too,
   * since tmux catches SIGTERM (0, on 3.5), so only the kill tells the two apart.
   */
  readonly answered: boolean;

  constructor(args: readonly string[], cause: unknown) {
    const of = (key: string): unknown =>
      typeof cause === "object" && cause !== null ? Reflect.get(cause, key) : undefined;
    const raw = of("stderr");
    const stderr = typeof raw === "string" ? raw.trim() : "";
    const shown = redacted(args);
    const code = of("code");
    const killed = of("killed") === true;
    const signal = of("signal");
    // The child process's own error names the whole command line, so it is not kept as the cause.
    super(`tmux ${shown.join(" ")} failed${stderr ? `: ${stderr}` : ""}`, {
      cause: Object.assign(new Error(`tmux exited ${String(code)}`), { code, killed, signal }),
    });
    this.args = shown;
    this.stderr = stderr;
    this.answered = typeof code === "number" && !killed && typeof signal !== "string";
  }
}

export interface TmuxRuntimeOptions {
  /** Bazhen's private server, whose `config` is where TMUX_CONFIG is written before it starts. */
  readonly server: ConfiguredTmuxServer;
  readonly pty: PtySpawner;
  /**
   * The whole environment of every tmux command and of the daemon's attach clients. The server
   * copies it into every pane, so it must already be filtered (foundation-design §9.5).
   */
  readonly env: Readonly<Record<string, string>>;
  /** How often dead terminals are looked for while anyone listens. */
  readonly exitPollMs?: number;
  /** The most a history capture may print; tests lower it. */
  readonly captureMaxBytes?: number;
  /**
   * A command the server runs, in the background, whenever a pane's title changes, with the
   * pane's id appended. Without one, the hook is removed. A server started by an older daemon
   * gets this runtime's hook from `applyServerSettings` and from every terminal created.
   */
  readonly onPaneTitle?: readonly [string, ...string[]];
  /** Where a failure inside exit polling goes, since no caller is waiting on it. */
  readonly onError?: (err: unknown) => void;
}

export class TmuxRuntime implements RuntimeAdapter {
  readonly kind = "tmux";
  private readonly opts: TmuxRuntimeOptions;
  /** `opts.env` until `replaceEnv` changes it. */
  private env: Readonly<Record<string, string>>;
  private readonly exits: ExitWatch;
  private readonly unknownCause = new UnknownCause(UNKNOWN_EXIT_AFTER_MS);
  /** Until `applyServerSettings` reaches a running server; `health` applies them meanwhile. */
  private settingsPending = true;

  constructor(opts: TmuxRuntimeOptions) {
    this.opts = opts;
    this.env = opts.env;
    this.exits = new ExitWatch({
      read: () => this.deadTerminals(),
      intervalMs: opts.exitPollMs ?? EXIT_POLL_MS,
      onError: opts.onError ?? ((err) => console.warn("tmux exit polling failed:", err)),
    });
    writeFileSync(opts.server.config, TMUX_CONFIG, { mode: 0o600 });
  }

  /**
   * Replaces the environment every new terminal starts from (foundation-design §9.5). A server
   * already running takes it at once: what changed goes into its global environment through
   * host-guard's `setEnvironment`, never argv. Terminals already running keep what they have.
   * Resolves with the names it left as they were, set or removed, whose names or values tmux's
   * parser can't take as data (an exported shell function, a value with a newline): a new server
   * gets them right anyway.
   */
  async replaceEnv(env: Readonly<Record<string, string>>): Promise<{ refused: string[] }> {
    if (!this.opts.server.alive()) {
      this.env = env;
      return { refused: [] };
    }
    // Run with the new environment, and kept only once tmux has taken it, so a failure leaves
    // the runtime, the server and the daemon's record agreeing on the old one.
    const show = ["show-environment", "-g"];
    const out = await this.opts.server.run(show, { env }).catch((cause: unknown) => {
      throw new TmuxError(show, cause);
    });
    const current = parseEnvironment(out);
    const changed = Object.entries(env).filter(([k, v]) => current.get(k) !== v);
    const gone = [...current.keys()].filter((k) => !Object.hasOwn(env, k));
    const set = Object.fromEntries(changed.filter(([k, v]) => isSafeEnvEntry(k, v)));
    const unset = gone.filter((k) => isSafeEnvEntry(k));
    await this.opts.server.setEnvironment(set, unset, { env });
    this.env = env;
    const refused = [...changed.map(([k]) => k), ...gone].filter(
      (k) => !Object.hasOwn(set, k) && !unset.includes(k),
    );
    return { refused };
  }

  private async tmux(...args: string[]): Promise<string> {
    return (await this.tmuxOutput(args)).trimEnd();
  }

  /** What tmux printed, untrimmed: blank lines at its end can be content. */
  private async tmuxOutput(args: readonly string[], maxBytes?: number): Promise<string> {
    try {
      return await this.opts.server.run(args, {
        env: this.env,
        ...(maxBytes === undefined ? {} : { maxBytes }),
      });
    } catch (cause) {
      throw new TmuxError(args, cause);
    }
  }

  /**
   * With no server answering, a server `recorded` names that still runs had its socket deleted
   * under it (macOS temp cleaners do): it is sent SIGUSR1 to recreate it, and is `unreachable`
   * meanwhile. Nothing runs only once every recorded server is gone (foundation-design §7.1).
   */
  async health(recorded: readonly RuntimeRef[] = []): Promise<RuntimeHealth> {
    let version: string;
    try {
      version = await this.tmux("-V");
    } catch {
      return { state: "unreachable", version: null };
    }
    try {
      await this.tmux("list-sessions", "-F", "#{session_id}");
      // Settings that found no server, as when one is still recreating a deleted socket, go on here.
      if (this.settingsPending)
        await this.applyServerSettings().catch(this.opts.onError ?? reportSettings);
      return { state: "healthy", version };
    } catch (err) {
      if (!(err instanceof TmuxError)) throw err;
      if (!noServer(err)) return { state: "unreachable", version };
    }
    // Only once every recorded server is provably gone: one that serves, or can't be told apart,
    // concludes nothing.
    for (const identity of identities(recorded)) {
      const verdict = await this.opts.server.recreateSocket(identity);
      if (verdict.is !== "gone") return { state: "unreachable", version };
    }
    return { state: "not-running", version };
  }

  async create(spec: TerminalSpec): Promise<RuntimeRef> {
    const session = sessionName(spec.terminalId);
    const { cols, rows } = spec.size;
    await this.tmux(
      ...sequence([
        // TMUX_CONFIG's history-limit reaches only a server it starts, and tmux applies the limit
        // to a pane as the pane is made: on a server an older daemon left running, set it again
        // first. Terminals already open keep the limit they were made with.
        ["set-option", "-g", "history-limit", String(HISTORY_LINES)],
        [
          "new-session",
          "-d",
          "-s",
          session,
          "-x",
          String(cols),
          "-y",
          String(rows),
          ...processArgs(spec),
        ],
        styleCommand(windowOf(session), spec.theme),
      ]),
    );
    const location = await this.tmux(
      ...sequence([
        ...tagCommands(session, spec.terminalId, spec.tags),
        generationCommand(windowOf(session), spec.generation),
        ["set-option", "-w", "-t", windowOf(session), "window-size", "manual"],
        this.paneTitleHook(),
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

  /**
   * Puts this runtime's server-wide settings on a server that is already running, which read its
   * configuration from whichever daemon started it: the pane-title hook, and the keys that leave
   * a mode. With no server running it does nothing, and starts none; the next `health` that
   * reaches one applies them, as it does after a server too slow to answer. A server that answers
   * and refuses them is not asked again.
   */
  async applyServerSettings(): Promise<void> {
    try {
      await this.tmux(...sequence([this.paneTitleHook(), ...MODE_EXIT_BINDINGS]));
    } catch (err) {
      if (err instanceof TmuxError && noServer(err)) return;
      if (err instanceof TmuxError && err.answered) this.settingsPending = false;
      throw err;
    }
    this.settingsPending = false;
  }

  private paneTitleHook(): string[] {
    const hook = this.opts.onPaneTitle;
    return hook === undefined
      ? ["set-hook", "-gu", "pane-title-changed"]
      : ["set-hook", "-g", "pane-title-changed", paneHook(hook)];
  }

  /** The tmux server's socket, as each terminal's locator names it. */
  get socket(): string {
    return this.opts.server.socket;
  }

  /** A terminal's pane title, which the program in it sets, as a Codex TUI does to its thread. */
  async paneTitle(ref: RuntimeRef): Promise<string> {
    return this.tmux("display-message", "-p", "-t", located(ref, "paneId"), "#{pane_title}");
  }

  private locator(row: Row): Record<string, string> {
    return {
      socket: this.opts.server.socket,
      ...Object.fromEntries(LOCATION_KEYS.map((k) => [k, row(k)])),
    };
  }

  async inventory(): Promise<RuntimeInventoryEntry[]> {
    const out = await this.tmux("list-panes", "-a", "-F", PANE.format).catch((err: unknown) => {
      // No server, so nothing on its socket; whether that means gone is health's to say.
      if (err instanceof TmuxError && noServer(err)) return "";
      throw err;
    });
    const rows = out.split("\n").flatMap((line) => {
      const row = PANE.parse(line);
      const tagged = decodeTags(row);
      if (tagged === null) return [];
      const dead = row("dead") === "1";
      return [
        {
          key: [tagged.terminalId, row("paneId"), row("generation")].join(" "),
          ref: { terminalId: tagged.terminalId, runtime: this.kind, locator: this.locator(row) },
          tags: tagged.tags,
          exit: dead ? exitStatus(row("status"), row("deadSignal")) : null,
        },
      ];
    });
    return this.unknownCause
      .settle(rows, Date.now())
      .map(({ ref, tags, exit }) => ({ ref, tags, exit }));
  }

  async attach(ref: RuntimeRef, size: Size | null, historyLines: number): Promise<HistoryAttached> {
    // Found by its tag on the server it was made on: a session name or number alone could, after a
    // restart, name another terminal.
    const [pane] = await this.panesOf(ref);
    if (pane === undefined) throw new StaleIncarnation(ref.terminalId, "gone");
    const session = located(pane.ref, "sessionId");
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
    const history = lines > 0 ? await this.historyOf(session, lines) : "";
    const proc = this.opts.pty.spawn(
      this.opts.server.argv("attach-session", "-t", session),
      { cols, rows },
      this.env,
    );
    const screen = new ScreenWatch({
      quietMs: SCREEN_QUIET_MS,
      maxWaitMs: SCREEN_MAX_WAIT_MS,
      check: async () =>
        (await this.tmux("display-message", "-p", "-t", windowOf(session), "#{alternate_on}")) ===
        "1",
      alternate: alternate === 1,
    });
    proc.onData(() => screen.poke());
    const closeHandlers: Array<() => void> = [];
    let closed = false;
    proc.onExit(() => {
      closed = true;
      screen.dispose();
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
      onAlternate: (cb) => screen.onAlternate(cb),
      onFailure: (cb) => screen.onFailure(cb),
      onRespawn: () => {},
      close: () => {
        screen.dispose();
        proc.kill();
      },
    };
    return { kind: "history", stream, history, alternate: alternate === 1 };
  }

  /**
   * A terminal the socket no longer carries counts as closed once it is provably gone (`gone`).
   * One whose server may still run, its socket deleted or taken by another, is unconfirmed, and
   * only a forced close records it closed (foundation-design §7.1).
   */
  /**
   * Up to `lines` of the history above the screen, oldest first, with their escapes. A history
   * too large to capture whole, as truecolor art takes 40 bytes a cell or more, gives its most
   * recent half, and so on: a view always opens, with as much as fits.
   */
  private async historyOf(session: string, lines: number): Promise<string> {
    const most = this.opts.captureMaxBytes ?? CAPTURE_MAX_BYTES;
    for (let n = lines; n > 0; n = Math.floor(n / 2)) {
      const args = [
        "capture-pane",
        "-p",
        "-e",
        "-J",
        "-t",
        windowOf(session),
        "-S",
        `-${n}`,
        "-E",
        "-1",
      ];
      try {
        return (await this.tmuxOutput(args, most)).replace(/\n$/, "");
      } catch (err) {
        if (!overflowed(err)) throw err;
      }
    }
    return "";
  }

  async close(ref: RuntimeRef): Promise<void> {
    const [pane] = await this.panesOf(ref).catch(async (err: unknown) => {
      const serverAway =
        (err instanceof TmuxError && noServer(err)) ||
        (err instanceof StaleIncarnation && err.reason === "server-replaced");
      // Another server carrying the terminal's tag is not its end.
      if (!serverAway || (await this.carries(ref))) throw err;
      if (await this.gone(ref)) return [];
      throw new TerminalUnconfirmed(ref.terminalId, err);
    });
    if (pane !== undefined) await this.tmux("kill-session", "-t", located(pane.ref, "sessionId"));
  }

  /**
   * Nothing on the socket carries the terminal, and the server it was made on is the one
   * answering, or is provably gone: a terminal ends with its server. One that can't be told apart
   * from it is no proof.
   */
  async gone(ref: RuntimeRef): Promise<boolean> {
    if (await this.carries(ref)) return false;
    const current = await this.server().catch((err: unknown) => {
      if (err instanceof TmuxError && noServer(err)) return undefined;
      throw err;
    });
    const { serverPid, serverStart } = ref.locator;
    if (
      current !== undefined &&
      current.serverPid === serverPid &&
      current.serverStart === serverStart
    )
      return true;
    return (await this.opts.server.verdict(identityOf(ref))).is === "gone";
  }

  private async carries(ref: RuntimeRef): Promise<boolean> {
    return (await this.inventory()).some((e) => e.ref.terminalId === ref.terminalId);
  }

  async respawn(ref: RuntimeRef, spec: ProcessSpec): Promise<RuntimeRef> {
    const pane = await this.paneOf(ref);
    if (pane.exit === null) throw new ProcessState(ref.terminalId, "exited");
    assertSameGeneration(ref, pane.ref.locator.generation);
    const target = located(pane.ref, "paneId");
    // tmux runs one client's command list without another client's commands in between. Were it
    // ever split, the number going first means a stale ref is refused rather than acting on the
    // new process.
    const location = await this.tmux(
      ...sequence([
        generationCommand(target, spec.generation),
        styleCommand(target, spec.theme),
        ["respawn-pane", "-t", target, ...processArgs(spec)],
        ["display-message", "-p", "-t", target, LOCATION.format],
      ]),
    );
    return { ...ref, locator: this.locator(LOCATION.parse(location)) };
  }

  /**
   * The pane's foreground, from the PTY, never the screen: tmux names the foreground group's
   * leader, and `ps` says which group holds the terminal, the pane's own process's or another.
   */
  async foreground(ref: RuntimeRef): Promise<Foreground> {
    const pane = await this.paneOf(ref);
    assertSameGeneration(ref, pane.ref.locator.generation);
    if (pane.exit !== null) throw new ProcessState(ref.terminalId, "running");
    const command = await this.tmux(
      "display-message",
      "-p",
      "-t",
      located(pane.ref, "paneId"),
      "#{pane_current_command}",
    );
    const pid = Number(pane.ref.locator.panePid);
    const group = await terminalForeground(pid);
    if (group === "absent") throw new ProcessState(ref.terminalId, "running");
    if (group === "unreadable")
      throw new Error(`can't read terminal ${ref.terminalId}'s foreground`);
    return { command, own: group === pid };
  }

  /**
   * One `list-panes`, kept to the terminals asked for, then one `ps` for which process group holds
   * each of them; nothing at all when none is asked for.
   */
  async foregrounds(terminalIds: ReadonlySet<string>): Promise<TerminalForeground[]> {
    if (terminalIds.size === 0) return [];
    const out = await this.tmux("list-panes", "-a", "-F", FOREGROUND.format).catch(
      (err: unknown) => {
        if (err instanceof TmuxError && noServer(err)) return "";
        throw err;
      },
    );
    const lines = out.split("\n");
    const panes = lines.flatMap((line, i) => {
      const row = FOREGROUND.parse(line);
      const tagged = decodeTags(row);
      const pid = Number(row("panePid"));
      if (tagged === null || !terminalIds.has(tagged.terminalId)) return [];
      if (row("dead") === "1" || !Number.isInteger(pid)) return [];
      const ref = { terminalId: tagged.terminalId, runtime: this.kind, locator: this.locator(row) };
      // The path is the last column and tmux prints it raw: a tab in it makes extra columns, and a
      // newline carries its end onto a line of its own. Either way what was read is not the path.
      const next = lines[i + 1] ?? "";
      const cut =
        line.split("\t").length !== FOREGROUND.width ||
        (next !== "" && decodeTags(FOREGROUND.parse(next)) === null);
      return [{ ref, pid, command: row("currentCommand"), cwd: cut ? null : row("currentPath") }];
    });
    const groups = await terminalGroups(panes.map((p) => p.pid));
    if (groups === "unreadable") throw new Error("can't read the terminals' foreground groups");
    return panes.flatMap(({ ref, pid, command, cwd }) => {
      const group = groups.get(pid);
      return group !== undefined && group > 0 ? [{ ref, command, own: group === pid, cwd }] : [];
    });
  }

  async unlink(ref: RuntimeRef): Promise<void> {
    const pane = await this.paneOf(ref);
    await this.tmux("set-option", "-u", "-t", located(pane.ref, "sessionId"), COLUMN.linkedAgentId);
  }

  async signal(ref: RuntimeRef, signal: Signal): Promise<void> {
    const pane = await this.paneOf(ref);
    if (pane.exit !== null) throw new ProcessState(ref.terminalId, "running");
    assertSameGeneration(ref, pane.ref.locator.generation);
    const target = located(pane.ref, "paneId");
    // The pane's process leads its own group, so this reaches the tools it started as well.
    // A group that exited after the check above is the poller's to report.
    // The process the caller meant, not whichever the pane runs now.
    const expected = { pid: ref.locator.panePid ?? "", generation: ref.locator.generation ?? "" };
    const group = await this.opts.server
      .paneGroup(target, expected, { env: this.env })
      .catch((cause: unknown) => {
        if (cause instanceof PaneRefused && cause.reason === "dead") {
          throw new ProcessState(ref.terminalId, "running");
        }
        if (cause instanceof PaneRefused) {
          throw new StaleIncarnation(ref.terminalId, "process-replaced");
        }
        throw new TmuxError(["display-message", "-t", target], cause);
      });
    signalPane(group, signal);
  }

  onExit(cb: (ref: RuntimeRef, status: ExitStatus) => void): () => void {
    return this.exits.subscribe(cb);
  }

  /** By session id, which no other session can take while this one lives, unlike its name. */
  attachCommand(ref: RuntimeRef): string {
    const target = ref.locator.sessionId || sessionOf(ref);
    const argv = this.opts.server.argv("attach-session", "-t", target);
    // Unset, or tmux inside the user's own tmux refuses to nest.
    return shellCommand(["env", "-u", "TMUX", ...argv]);
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

  private async server(): Promise<{ serverPid: string; serverStart: string }> {
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
 * What a terminal's programs read to choose 24-bit colour. tmux 3.6 sets it in every pane, over
 * whatever `-e` or the server's environment says, and earlier versions don't set it. So it is
 * given to the pane's process by `env`, which runs after tmux: a terminal draws the same on
 * whichever tmux runs, and a value the spec carries wins, as a user's `agents.env.passthrough` of
 * it is deliberate.
 */
const DEFAULT_COLORTERM = "truecolor";

/**
 * The process half of a terminal: its directory, Bazhen's variables and its argv. tmux sets TMUX
 * and TMUX_PANE in every pane, whatever the server's environment, and with them a terminal's
 * `tmux kill-server` would end Bazhen's private server and every terminal on it. A new terminal
 * tab has neither, so `env` drops them and then execs the argv, which stays the pane's process.
 */
export const processArgs = (spec: ProcessSpec) => [
  "-c",
  spec.cwd,
  ...Object.entries(spec.env).flatMap(([k, v]) => ["-e", escapeTrailingSemicolon(`${k}=${v}`)]),
  "--",
  "env",
  "-u",
  "TMUX",
  "-u",
  "TMUX_PANE",
  "--",
  escapeTrailingSemicolon(`COLORTERM=${spec.env["COLORTERM"] ?? DEFAULT_COLORTERM}`),
  ...spec.argv.map(escapeTrailingSemicolon),
];

/** Each terminal's generation, written into its pane, because tmux 3.8 forgets a dead pane's pid. */
const generationCommand = (target: string, generation: number) => [
  "set-option",
  "-p",
  "-t",
  target,
  COLUMN.generation,
  String(generation),
];

function tagCommands(session: string, terminalId: TerminalId, tags: TerminalTags): string[][] {
  const options: [string, string][] = [
    [COLUMN.terminalId, terminalId],
    [COLUMN.kind, tags.kind],
  ];
  if (tags.kind === "agent") {
    options.push([COLUMN.agentId, tags.agentId]);
    if (tags.harnessSession) options.push([COLUMN.harnessSession, tags.harnessSession]);
  } else if (tags.linkedAgentId) options.push([COLUMN.linkedAgentId, tags.linkedAgentId]);
  return options.map(([option, value]) => ["set-option", "-t", session, option, value]);
}

/** The tags `tagCommands` wrote, or null for a pane whose tags Bazhen did not write. */
function decodeTags(row: Row): { terminalId: TerminalId; tags: TerminalTags } | null {
  const terminalId = row("terminalId");
  const agentId = row("agentId");
  const linked = row("linkedAgentId");
  if (!isId("term", terminalId)) return null;
  if (row("kind") === "agent") {
    if (!isId("agent", agentId)) return null;
    const session = row("harnessSession");
    const tags: TerminalTags = session
      ? { kind: "agent", agentId, harnessSession: session }
      : { kind: "agent", agentId };
    return { terminalId, tags };
  }
  if (row("kind") !== "shell") return null;
  return {
    terminalId,
    tags: isId("agent", linked) ? { kind: "shell", linkedAgentId: linked } : { kind: "shell" },
  };
}

/** The server `ref` was made on. */
const identityOf = ({ locator }: RuntimeRef): ServerIdentity => ({
  pid: locator.serverPid ?? "",
  start: locator.serverStart ?? "",
});

/** The distinct servers `refs` were made on. */
function identities(refs: readonly RuntimeRef[]): ServerIdentity[] {
  const seen = new Map<string, ServerIdentity>();
  for (const identity of refs.map(identityOf)) {
    if (identity.pid !== "" && identity.start !== "")
      seen.set(`${identity.pid} ${identity.start}`, identity);
  }
  return [...seen.values()];
}

const reportSettings = (err: unknown) =>
  console.warn("tmux server settings were not applied:", err);

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

/**
 * The hook that runs `argv` in the background with the pane's id appended, its output and status
 * discarded: tmux shows a `run-shell` that prints or fails in the pane, in view mode, so a missing
 * client would otherwise take over the pane on every title change. tmux parses a hook as
 * a command line, so the shell command goes in double quotes, with `\\`, `"` and `$` escaped, and
 * run-shell expands it as a format: each word's `#` is doubled, so only the `#{pane_id}` added
 * here is one. Each word is single-quoted for the shell.
 */
export function paneHook(argv: readonly string[]): string {
  const words = argv.map((w) => `'${w.replaceAll("'", "'\\''").replaceAll("#", "##")}'`);
  const shell = `${[...words, "'#{pane_id}'"].join(" ")} >/dev/null 2>&1 || :`;
  return `run-shell -b "${shell.replace(/[\\"$]/g, (c) => `\\${c}`)}"`;
}

/** Several tmux commands as one invocation: a lone `;` argument separates them. */
/**
 * The window's style in the theme its process starts for. tmux answers a pane's OSC 10/11 query
 * from it, so a program asking at its first instruction, before any client attaches, is told the
 * terminal's colours (and painted in them, which is what the terminal is drawn in). Set in the
 * same command list as the process it is for, so tmux reads none of the process's output before.
 * With no theme it is unset, and a query goes to an attached client, as tmux does by default.
 */
function styleCommand(target: string, theme: TuiTheme | undefined): string[] {
  if (theme === undefined) return ["set-option", "-w", "-u", "-t", target, "window-style"];
  const { text, background } = TERMINAL_COLOURS[theme];
  return ["set-option", "-w", "-t", target, "window-style", `fg=${text},bg=${background}`];
}

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

/**
 * `show-environment -g`: one `NAME=value` per line, and `-NAME` for one marked removed, which
 * no pane gets either.
 */
function parseEnvironment(out: string): Map<string, string> {
  const vars = new Map<string, string>();
  for (const line of out.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0 && !line.startsWith("-")) vars.set(line.slice(0, at), line.slice(at + 1));
  }
  return vars;
}

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
  HistoryStream,
  StreamEnd,
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
  PasteRefused,
  isSafeEnvEntry,
  signalPane,
  terminalGroups,
  terminalForeground,
  type ConfiguredTmuxServer,
  type ServerIdentity,
} from "@bazhen/host-guard";
import {
  assertSameGeneration,
  ProcessWatch,
  isId,
  ProcessState,
  shellCommand,
  StaleIncarnation,
  TerminalUnconfirmed,
  UnsupportedRuntime,
  type ObservedProcess,
  type ScreenText,
} from "@bazhen/core";
import { exitStatus, UnknownCause } from "./exit-status.ts";
import { ExitWatch } from "./exit-watch.ts";
import { redacted } from "./redact.ts";

import { ScreenWatch } from "./screen-watch.ts";

const PROCESS_POLL_MS = 1_000;
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
 * variables into a session. `history-limit` is only the default: `create` sets each terminal's
 * own. Without the smcup override, the client switches the browser's terminal to its alternate
 * buffer, which keeps no scrollback and turns the wheel into arrow keys. `resetDeadPanes` is
 * whether this tmux needs `DEAD_PANE_RESET`.
 */
export function tmuxConfig(resetDeadPanes: boolean): string {
  return `set -g prefix None
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
${resetDeadPanes ? `set-hook -g pane-died '${DEAD_PANE_RESET}'` : "set-hook -gu pane-died"}
`;
}

/**
 * Before 3.5, tmux writes a focus report to a dead pane's freed output whenever the pane's focus
 * changes, if its program had turned focus reports on (`\e[?1004h`), and the server crashes with
 * every terminal on it (tmux issue 3776). A TUI killed by a signal never turns them off, and
 * attaching to its pane or leaving it changes its focus. Resetting the pane as it dies turns them
 * off, and costs the dead pane its screen, which scrolls into history with the "Pane is dead"
 * line. The hook runs on the server's next pass, so a focus change in the same pass as the death
 * still crashes it. No `-t`: tmux before 3.5 doesn't expand a format there, and a hook's own
 * pane is the one that died. A live pane is never reset, should that ever not hold.
 */
const DEAD_PANE_RESET = 'if-shell -F "#{pane_dead}" "send-keys -R"';

/** Whether a tmux of this `[major, minor]` needs `DEAD_PANE_RESET`. */
export const resetsDeadPanes = ([major, minor]: readonly [number, number]) =>
  major < 3 || (major === 3 && minor < 5);

/** What `bazhen doctor` says of a tmux that needs `DEAD_PANE_RESET`. */
export const DEAD_PANE_WORKAROUND =
  "tmux before 3.5 crashes, ending every terminal, when a dead pane that asked for focus " +
  "reports gains or loses focus (fixed in tmux 3.5). Bazhen resets each pane as it dies, so a " +
  "dead terminal shows an empty screen with its last output scrolled into history. A focus " +
  "change at the very moment a terminal dies can still crash the server: upgrade to tmux 3.5.";

/**
 * Whether what `-V` (`tmux 3.6b`) or `#{version}` (`3.4`, `next-3.9`) printed names a tmux that
 * needs `DEAD_PANE_RESET`. One that can't be read is taken to, since the reset costs only a dead
 * pane's screen.
 */
function needsReset(version: string): boolean {
  const match = /^(?:tmux )?(?:next-)?(\d+)\.(\d+)/.exec(version.trim());
  return match === null || resetsDeadPanes([Number(match[1]), Number(match[2])]);
}

function deadPaneHook(reset: boolean): string[] {
  return reset
    ? ["set-hook", "-g", "pane-died", DEAD_PANE_RESET]
    : ["set-hook", "-gu", "pane-died"];
}

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
  /** Bazhen's private server, whose `config` is where `tmuxConfig` is written before it starts. */
  readonly server: ConfiguredTmuxServer;
  readonly pty: PtySpawner;
  /**
   * The whole environment of every tmux command and of the daemon's attach clients. The server
   * copies it into every pane, so it must already be filtered (foundation-design §9.5).
   */
  readonly env: Readonly<Record<string, string>>;
  /** How often terminals' processes are read while anyone listens. */
  readonly processPollMs?: number;
  /**
   * Whether a terminal is open on this runtime. While none is, terminals' processes aren't read,
   * so a daemon with no tmux terminal doesn't poll tmux. Without it, they always are.
   */
  readonly inUse?: () => boolean;
  /** The most a history capture may print; tests lower it. */
  readonly captureMaxBytes?: number;
  /**
   * A command the server runs, in the background, whenever a pane's title changes, with the
   * pane's id appended. Without one, the hook is removed. A server started by an older daemon
   * gets this runtime's hook from `applyServerSettings` and from every terminal created.
   */
  readonly onPaneTitle?: readonly [string, ...string[]];
  /**
   * What says whether a paste may go now, run by the server with the pane's tty and process id
   * appended, as `bazhen-hook pane-ready` does; exit 0 is yes. Without one, nothing is pasted.
   */
  readonly pasteGate?: readonly [string, ...string[]];
  /** Where a failure inside process polling goes, since no caller is waiting on it. */
  readonly onError?: (err: unknown) => void;
}

export class TmuxRuntime implements RuntimeAdapter {
  readonly kind = "tmux";
  private readonly opts: TmuxRuntimeOptions;
  /** `opts.env` until `replaceEnv` changes it. */
  private env: Readonly<Record<string, string>>;
  private readonly processes: ProcessWatch;
  private readonly unknownCause = new UnknownCause(UNKNOWN_EXIT_AFTER_MS);
  /** Until `applyServerSettings` reaches a running server; `health` applies them meanwhile. */
  private settingsPending = true;
  /** Whether the tmux this runtime runs needs `DEAD_PANE_RESET`. */
  private readonly resetDeadPanes: boolean;
  /** Each open client's exits, by its terminal, so a respawn here retires its process's at once. */
  private readonly exitWatches = new Map<string, Set<ExitWatch>>();

  constructor(opts: TmuxRuntimeOptions) {
    this.opts = opts;
    this.env = opts.env;
    this.processes = new ProcessWatch({
      read: () => this.observed(),
      intervalMs: opts.processPollMs ?? PROCESS_POLL_MS,
      ...(opts.inUse && { active: opts.inUse }),
      onError: opts.onError ?? ((err) => console.warn("tmux process polling failed:", err)),
    });
    const installed = (() => {
      try {
        return opts.server.runSync(["-V"], { env: opts.env });
      } catch {
        return "";
      }
    })();
    this.resetDeadPanes = needsReset(installed);
    writeFileSync(opts.server.config, tmuxConfig(this.resetDeadPanes), { mode: 0o600 });
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
    const workarounds = needsReset(version) ? [DEAD_PANE_WORKAROUND] : [];
    try {
      await this.tmux("list-sessions", "-F", "#{session_id}");
      // Settings that found no server, as when one is still recreating a deleted socket, go on here.
      if (this.settingsPending)
        await this.applyServerSettings().catch(this.opts.onError ?? reportSettings);
      return { state: "healthy", version, workarounds };
    } catch (err) {
      if (!(err instanceof TmuxError)) throw err;
      if (!noServer(err)) return { state: "unreachable", version, workarounds };
    }
    // Only once every recorded server is provably gone: one that serves, or can't be told apart,
    // concludes nothing.
    for (const identity of identities(recorded)) {
      const verdict = await this.opts.server.recreateSocket(identity);
      if (verdict.is !== "gone") return { state: "unreachable", version, workarounds };
    }
    return { state: "not-running", version, workarounds };
  }

  async create(spec: TerminalSpec): Promise<RuntimeRef> {
    const session = sessionName(spec.terminalId);
    const { cols, rows } = spec.size;
    await this.tmux(
      ...sequence([
        // tmux applies the server-wide limit to a pane as the pane is made, so it is set for each
        // terminal in the same command as its new-session: split in two, a concurrent create of
        // another depth could land between them. Terminals already open keep the limit they were
        // made with.
        ["set-option", "-g", "history-limit", String(spec.historyLines)],
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
   * configuration from whichever daemon started it: the pane-title hook, the dead-pane reset the
   * server's own version needs, and the keys that leave a mode. With no server running it does nothing, and starts none; the next `health` that
   * reaches one applies them, as it does after a server too slow to answer. A server that answers
   * and refuses them is not asked again.
   */
  async applyServerSettings(): Promise<void> {
    try {
      const version = await this.tmux("display-message", "-p", "#{version}");
      await this.tmux(
        ...sequence([
          this.paneTitleHook(),
          deadPaneHook(needsReset(version)),
          ...MODE_EXIT_BINDINGS,
        ]),
      );
    } catch (err) {
      if (err instanceof TmuxError && noServer(err)) return;
      if (err instanceof TmuxError && err.answered) this.settingsPending = false;
      throw err;
    }
    this.settingsPending = false;
  }

  private async resetIfDead(paneId: string): Promise<void> {
    const reset = this.deadPaneReset(paneId);
    if (reset.length > 0) await this.tmux(...sequence(reset));
  }

  /**
   * `DEAD_PANE_RESET` for one pane, when this tmux needs it, as a client is about to attach to it
   * or leave it. The hook alone isn't enough: a tmux built with utempter can lose a pane's SIGCHLD
   * before 3.6, leaving it dead with no status, and then `pane-died` never fires.
   */
  private deadPaneReset(paneId: string): string[][] {
    return this.resetDeadPanes
      ? [["if-shell", "-F", "-t", paneId, "#{pane_dead}", `send-keys -R -t ${paneId}`]]
      : [];
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

  async title(ref: RuntimeRef): Promise<string> {
    return this.tmux("display-message", "-p", "-t", located(ref, "paneId"), "#{pane_title}");
  }

  private locator(row: Row): Record<string, string> {
    return {
      socket: this.opts.server.socket,
      ...Object.fromEntries(LOCATION_KEYS.map((k) => [k, row(k)])),
    };
  }

  async inventory(): Promise<RuntimeInventoryEntry[]> {
    return (await this.panes()).map(({ ref, tags, exit }) => ({ ref, tags, exit }));
  }

  /** Every tagged pane, a death of unknown cause still in its grace marked `held`. */
  private async panes() {
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
    return this.unknownCause.settle(rows, Date.now());
  }

  async attach(ref: RuntimeRef, size: Size | null): Promise<HistoryAttached> {
    // Found by its tag on the server it was made on: a session name or number alone could, after a
    // restart, name another terminal.
    const [pane] = await this.panesOf(ref);
    if (pane === undefined) throw new StaleIncarnation(ref.terminalId, "gone");
    const session = located(pane.ref, "sessionId");
    const resizeWindow = (next: Size) => this.tmux(...resizeArgs(session, next));
    if (size !== null) await resizeWindow(size);
    const [cols = 80, rows = 24, held = 0, alternate = 0, historyLines = 0] = (
      await this.tmux(
        "display-message",
        "-p",
        "-t",
        windowOf(session),
        "#{window_width} #{window_height} #{history_size} #{alternate_on} #{history_limit}",
      )
    )
      .split(" ")
      .map(Number);
    // A program on its alternate screen has no history of its own: tmux's is the main screen's,
    // behind it. With no history, `-E -1` would capture the screen's first line instead. A resize
    // that shrinks the screen pushes its lines into history past the limit until tmux next trims.
    const lines = alternate === 1 ? 0 : Math.min(historyLines, held);
    const history = lines > 0 ? await this.historyOf(session, lines) : "";
    const paneId = located(pane.ref, "paneId");
    await this.resetIfDead(paneId);
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
    const exits = this.watchExits(ref.terminalId, Number(pane.ref.locator.generation));
    proc.onData(() => exits.watch.output());
    const closeHandlers: Array<(why: StreamEnd) => void> = [];
    let closed = false;
    proc.onExit(() => {
      closed = true;
      screen.dispose();
      exits.stop();
      for (const h of closeHandlers) h("ended");
    });
    const stream: HistoryStream = {
      size: { cols, rows },
      onData: (cb) => proc.onData(cb),
      onClose: (cb) => {
        if (closed) cb("ended");
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
      onExit: (cb) => exits.watch.onExit(cb),
      get exited() {
        return exits.watch.exited;
      },
      close: () => {
        screen.dispose();
        exits.stop();
        // Closing the master alone hangs the client up only once every copy of it is closed, and
        // a later attach client can inherit one. tmux detaches the client by its terminal
        // device, which names no other PTY while this master is open, and only then: `tty` is
        // undefined once it has closed. The reset runs first, in the same list, so the client
        // never leaves a dead pane that asked for focus reports.
        const { tty } = proc;
        const leaving = [
          ...this.deadPaneReset(paneId),
          ...(tty === undefined ? [] : [["detach-client", "-t", tty]]),
        ];
        void (leaving.length === 0 ? Promise.resolve("") : this.tmux(...sequence(leaving)))
          .catch(() => undefined)
          .finally(() => proc.hangUp());
      },
    };
    return { kind: "history", stream, history, alternate: alternate === 1, historyLines };
  }

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

  /**
   * A terminal the socket no longer carries counts as closed once it is provably gone (`gone`).
   * One whose server may still run, its socket deleted or taken by another, is unconfirmed, and
   * only a forced close records it closed (foundation-design §7.1).
   */
  async close(ref: RuntimeRef): Promise<void> {
    const [pane] = await this.panesOf(ref).catch(async (err: unknown) => {
      await this.endedWithServer(ref, err);
      return [];
    });
    if (pane === undefined) return;
    await this.tmux("kill-session", "-t", located(pane.ref, "sessionId")).catch((err: unknown) =>
      this.endedWithServer(ref, err),
    );
  }

  /**
   * Returns when `err`, a command for `ref` that failed, shows the terminal ended with its server.
   * Throws `TerminalUnconfirmed` while that server may still run it, and rethrows any other
   * failure.
   */
  private async endedWithServer(ref: RuntimeRef, err: unknown): Promise<void> {
    const serverAway =
      (err instanceof TmuxError && noServer(err)) ||
      (err instanceof StaleIncarnation && err.reason === "server-replaced");
    // Another server carrying the terminal's tag is not its end.
    if (!serverAway || (await this.carries(ref))) throw err;
    if (!(await this.gone(ref))) throw new TerminalUnconfirmed(ref.terminalId, err);
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
        // A killed program never empties its title, and respawn-pane keeps it for the next one.
        ["select-pane", "-T", "", "-t", target],
        ["respawn-pane", "-t", target, ...processArgs(spec)],
        ["display-message", "-p", "-t", target, LOCATION.format],
      ]),
    );
    for (const watch of this.exitWatches.get(ref.terminalId) ?? [])
      watch.respawned(spec.generation);
    return { ...ref, locator: this.locator(LOCATION.parse(location)) };
  }

  /**
   * A client's watch on its terminal's exits from the process reports, until `stop`, from the
   * process of `generation` on.
   */
  private watchExits(terminalId: string, generation: number) {
    const watch = new ExitWatch(SCREEN_QUIET_MS, SCREEN_MAX_WAIT_MS, generation);
    const watches = this.exitWatches.get(terminalId) ?? new Set();
    watches.add(watch);
    this.exitWatches.set(terminalId, watches);
    const unsubscribe = this.processes.subscribe((ref, exit) => {
      if (ref.terminalId === terminalId) watch.report(Number(ref.locator.generation), exit);
    });
    let stopped = false;
    const stop = () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
      watch.dispose();
      watches.delete(watch);
      if (watches.size === 0) this.exitWatches.delete(terminalId);
    };
    return { watch, stop };
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

  /** Not on tmux: a screen is read from a holder's engine, which a tmux terminal has none of. */
  async screen(ref: RuntimeRef): Promise<ScreenText> {
    throw new UnsupportedRuntime(
      `terminal ${ref.terminalId} runs on tmux, whose screens can't be read: only a holder terminal's can`,
    );
  }

  /**
   * Through host-guard's `paste`, on tmux's stdin: the text never reaches argv, and a failure's
   * error carries none of what tmux printed, which could quote it.
   */
  async paste(ref: RuntimeRef, text: string, brackets: boolean): Promise<void> {
    const pane = await this.paneOf(ref);
    if (pane.exit !== null) throw new ProcessState(ref.terminalId, "running");
    assertSameGeneration(ref, pane.ref.locator.generation);
    // The process the caller meant, not whichever the pane runs now.
    if (pane.ref.locator.panePid !== ref.locator.panePid)
      throw new StaleIncarnation(ref.terminalId, "process-replaced");
    const target = located(pane.ref, "paneId");
    const gate = this.opts.pasteGate;
    if (gate === undefined) throw new PasteRefused("no paste gate is set up");
    await this.opts.server
      .paste(target, text, brackets, gate, { env: this.env })
      .catch((cause: unknown) => {
        if (cause instanceof RangeError || cause instanceof PasteRefused) throw cause;
        const of = (key: string): unknown =>
          typeof cause === "object" && cause !== null ? Reflect.get(cause, key) : undefined;
        const status = { code: of("code"), killed: of("killed"), signal: of("signal") };
        throw new TmuxError(["paste-buffer", "-t", target], status);
      });
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

  onProcess(cb: (ref: RuntimeRef, exit: ExitStatus | null) => void): () => void {
    return this.processes.subscribe(cb);
  }

  /** By session id, which no other session can take while this one lives, unlike its name. */
  attachCommand(ref: RuntimeRef): string {
    const target = ref.locator.sessionId || sessionOf(ref);
    const argv = this.opts.server.argv("attach-session", "-t", target);
    // Unset, or tmux inside the user's own tmux refuses to nest.
    return shellCommand(["env", "-u", "TMUX", ...argv]);
  }

  private async observed(): Promise<readonly ObservedProcess[]> {
    try {
      // A held pane has died, so it is not reported running; it is reported once its grace ends.
      return (await this.panes()).filter((pane) => pane.held !== true);
    } catch (err) {
      // An unreadable server is no evidence of what its terminals run (foundation-design §7.1).
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

  /**
   * The pane `ref` recorded: respawn and signal act on it and on nothing else. A terminal that
   * ended with its server is gone, not out of reach, since no repeat of the command can find it.
   */
  private async paneOf(ref: RuntimeRef): Promise<RuntimeInventoryEntry> {
    const panes = await this.panesOf(ref).catch(async (err: unknown) => {
      if (err instanceof TmuxError && noServer(err) && (await this.gone(ref)))
        throw new StaleIncarnation(ref.terminalId, "gone");
      throw err;
    });
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

/**
 * The socket is missing, nobody listens on it, or the server closed the connection without an
 * answer, as one that is shutting down does to every client. Any other failure says nothing
 * about the server.
 */
const noServer = (err: TmuxError) =>
  /no server running|error connecting to .* \((No such file or directory|Connection refused)\)|^server exited unexpectedly$/m.test(
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

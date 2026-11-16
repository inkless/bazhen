import type {
  AgentInventoryEntry,
  AgentLaunch,
  AgentLaunchRequest,
  AgentRefs,
  AgentRespawn,
  AgentSessionId,
  HarnessLaunch,
  ProcessSpec,
  EnvironmentAdapter,
  EnvironmentHealth,
  EnvironmentHealthState,
  EnvironmentId,
  HarnessAdapter,
  Resumes,
  RuntimeAdapter,
  RuntimeRef,
  ShellForeground,
  ShellInventoryEntry,
  ShellOpen,
  Compatibility,
} from "@bazhen/core";
import type {
  ExitStatus,
  ExternalRef,
  HarnessId,
  RuntimeHealthState,
  Signal,
  TuiTheme,
} from "@bazhen/protocol";
import {
  AgentTerminalExists,
  NoTerminal,
  NotResumable,
  ProcessState,
  RoutedRuntime,
  StaleIncarnation,
  UnsupportedHarness,
} from "@bazhen/core";

const basename = (path: string) => path.split("/").at(-1) ?? path;

/**
 * `argv` started through the user's login shell. The harness's argv goes in as the shell's own
 * arguments, never inside its command string, so no quoting is involved: fish reads them as
 * `$argv`, and bash, zsh and sh as `"$@"` (after `sh`, which fills `$0`). `exec` keeps the TUI
 * the pane's own process.
 */
export function loginArgv(shell: string, argv: readonly string[]): [string, ...string[]] {
  return basename(shell) === "fish"
    ? [shell, "-l", "-i", "-c", "exec $argv", ...argv]
    : [shell, "-l", "-i", "-c", 'exec "$@"', "sh", ...argv];
}

export interface LocalEnvironmentOptions {
  readonly id: EnvironmentId;
  /** One runtime, or a routed one over several, whose default new terminals are created on. */
  readonly runtime: RuntimeAdapter;
  readonly harnesses: readonly HarnessAdapter[];
  /** The daemon's Unix socket, handed to every agent as BAZHEN_SOCKET. */
  readonly socket: string;
  /**
   * With `agents.shell = "login"`, the user's login shell, which each agent then starts through,
   * re-reading the user's rc as a new terminal tab does (foundation-design §9.5).
   */
  readonly loginShell?: string;
  /** The user's shell, by absolute path, which shell terminals run; `/bin/sh` without one. */
  readonly shell?: string;
  /** How many lines of history above its screen each terminal it creates keeps. */
  readonly historyLines: number;
}

/**
 * How the runtime's health reads as the environment's (foundation-design §4.4). The runtime says
 * `not-running` only once every server the daemon recorded is gone, so nothing running is a
 * reachable environment with nothing in it: what lets a reconcile conclude `lost`.
 */
const HEALTH: Record<RuntimeHealthState, EnvironmentHealthState> = {
  healthy: "reachable",
  "not-running": "reachable",
  unreachable: "unreachable",
};

/**
 * The machine Bazhen runs on: agents are terminals in the private runtime, each running one
 * harness's TUI (foundation-design §8.1).
 */
export class LocalEnvironment implements EnvironmentAdapter {
  readonly kind = "local";
  readonly id: EnvironmentId;
  readonly harnesses: readonly HarnessId[];
  readonly resumes: Resumes;
  readonly themes: Readonly<Partial<Record<HarnessId, readonly TuiTheme[]>>>;
  readonly runtimes: readonly string[];
  readonly defaultRuntime: string;
  private readonly opts: LocalEnvironmentOptions;
  private readonly runtime: RoutedRuntime;

  constructor(opts: LocalEnvironmentOptions) {
    this.id = opts.id;
    this.harnesses = opts.harnesses.map((h) => h.id);
    this.resumes = ({ harness: id, externalRef, transcript }) => {
      const harness = opts.harnesses.find((h) => h.id === id);
      if (harness?.resumeSpec === undefined || externalRef === null) return false;
      return harness.canResume?.({ transcript }) ?? true;
    };
    this.themes = Object.fromEntries(opts.harnesses.map((h) => [h.id, h.themes]));
    this.opts = opts;
    this.runtime =
      opts.runtime instanceof RoutedRuntime
        ? opts.runtime
        : new RoutedRuntime({
            runtimes: [opts.runtime],
            defaultKind: opts.runtime.kind,
            // With one runtime, a failure to read it is thrown, never only reported.
            onError: () => {},
          });
    this.runtimes = this.runtime.kinds;
    this.defaultRuntime = this.runtime.defaultKind;
  }

  /** `known`'s servers, by their pid and start time, tell a dead server from a lost socket (§7.1). */
  async health(known: readonly RuntimeRef[] = [], runtime?: string): Promise<EnvironmentHealth> {
    const { state, version } = await this.read(runtime).health(known);
    return { state: HEALTH[state], version };
  }

  /** Every runtime, or only the one named. */
  private read(runtime: string | undefined): RuntimeAdapter {
    return runtime === undefined ? this.runtime : this.runtime.only(runtime);
  }

  compatibility(): Promise<Compatibility> {
    return this.runtime.compatibility();
  }

  async inventory(runtime?: string): Promise<AgentInventoryEntry[]> {
    return (await this.read(runtime).inventory()).flatMap((e) => {
      if (e.tags.kind !== "agent") return [];
      const entry = { agentId: e.tags.agentId, ref: e.ref, dead: e.exit !== null };
      const externalRef = harnessSessionOf(e.tags.harnessSession, this.id);
      return [externalRef === undefined ? entry : { ...entry, externalRef }];
    });
  }

  async shells(runtime?: string): Promise<ShellInventoryEntry[]> {
    return (await this.read(runtime).inventory()).flatMap((e) =>
      e.tags.kind !== "shell"
        ? []
        : [
            {
              ref: e.ref,
              dead: e.exit !== null,
              ...(e.tags.linkedAgentId && { linkedAgentId: e.tags.linkedAgentId }),
            },
          ],
    );
  }

  /**
   * The user's shell as an interactive login shell, as a new terminal tab runs it (§4.8). It is
   * told its terminal and Bazhen's socket, and the paired device that opened it, never an agent
   * id: a harness started in it by hand is not one of Bazhen's agents, so its hooks do nothing.
   */
  openShell({
    terminalId,
    cwd,
    linkedAgentId,
    size,
    theme,
    openedBy,
    integration,
    runtime,
  }: ShellOpen): Promise<RuntimeRef> {
    return this.runtime.create({
      terminalId,
      tags: linkedAgentId === undefined ? { kind: "shell" } : { kind: "shell", linkedAgentId },
      argv: [this.shell, "-l", "-i"],
      cwd,
      env: {
        BAZHEN_TERMINAL_ID: terminalId,
        BAZHEN_SOCKET: this.opts.socket,
        ...(openedBy && { BAZHEN_DEVICE_ID: openedBy }),
        ...(integration && {
          BAZHEN_SHELL_TOKEN: integration.token,
          BAZHEN_HOOK: integration.hook,
          BAZHEN_SHELL_INTEGRATION: integration.dir,
        }),
      },
      size,
      generation: 0,
      historyLines: this.opts.historyLines,
      ...(theme && { theme }),
      ...(runtime && { runtime }),
    });
  }

  /**
   * By the process group holding the terminal, not by name: a shell named otherwise than `$SHELL`,
   * as after an rc file's `exec zsh`, is still the shell.
   */
  async shellBusy(ref: RuntimeRef): Promise<string | null> {
    const { command, own } = await this.runtime.foreground(ref);
    // A login shell's process may be named with a leading dash, as `-fish`.
    return own ? null : command.replace(/^-/, "");
  }

  async shellForegrounds(refs: readonly RuntimeRef[]): Promise<ShellForeground[]> {
    const asked = new Set<string>(refs.map((r) => r.terminalId));
    return (await this.runtime.foregrounds(asked)).map((f) => ({
      ref: f.ref,
      // A login shell's process may be named with a leading dash, as `-fish`.
      command: f.own ? null : f.command.replace(/^-/, ""),
      cwd: f.cwd,
    }));
  }

  unlinkShell(ref: RuntimeRef): Promise<void> {
    return this.runtime.unlink(ref);
  }

  pasteShell(ref: RuntimeRef, text: string, brackets: boolean): Promise<void> {
    return this.runtime.paste(ref, text, brackets);
  }

  private get shell(): string {
    return this.opts.shell ?? "/bin/sh";
  }

  /** Without a recorded terminal there is nothing to prove gone, so it refuses rather than guess. */
  async close(refs: AgentRefs): Promise<void> {
    if (refs.runtime === null) throw new NoTerminal();
    await this.runtime.close(refs.runtime);
  }

  async gone(refs: AgentRefs): Promise<boolean> {
    if (refs.runtime === null) throw new NoTerminal();
    return this.runtime.gone(refs.runtime);
  }

  onExit(cb: (ref: RuntimeRef, status: ExitStatus) => void): () => void {
    return this.runtime.onExit(cb);
  }

  /**
   * Refuses an agent a terminal already carries, live or dead: an agent has one terminal at a time.
   * Only the runtime it is made on is read, and only while reachable; with no server running its
   * inventory is empty.
   */
  async launch({
    agentId,
    terminalId,
    generation,
    resume,
    request,
    options,
    size,
    runtime: on,
    tokenFile,
  }: AgentLaunch): Promise<AgentRefs> {
    const harness = this.harness(request);
    if (resume !== null && harness.resumeSpec === undefined) throw new NotResumable(agentId);
    const target = on ?? this.defaultRuntime;
    if ((await this.health([], target)).state === "reachable") {
      const carried = (await this.inventory(target)).some((e) => e.agentId === agentId);
      if (carried) throw new AgentTerminalExists(agentId);
    }
    const launch =
      resume === null || harness.resumeSpec === undefined
        ? await harness.launchSpec(request, options)
        : await harness.resumeSpec(request, resume, options);
    const externalRef = this.located(launch);
    const runtime = await this.runtime.create({
      ...this.process(agentId, request, launch, { generation, tokenFile }),
      terminalId,
      // Carried on the terminal too: a daemon that dies before recording it can still resume it.
      tags: externalRef
        ? { kind: "agent", agentId, harnessSession: JSON.stringify(externalRef) }
        : { kind: "agent", agentId },
      size,
      historyLines: this.opts.historyLines,
      ...(on && { runtime: on }),
    });
    return { runtime, externalRef, ...(launch.theme && { theme: launch.theme }) };
  }

  async respawn({
    agentId,
    request,
    options,
    refs,
    generation,
    tokenFile,
  }: AgentRespawn): Promise<AgentRefs & { readonly runtime: RuntimeRef }> {
    const harness = this.harness(request);
    if (refs.runtime === null) throw new NoTerminal();
    if (harness.resumeSpec === undefined || refs.externalRef === null)
      throw new NotResumable(agentId);
    await this.assertExited(refs.runtime);
    const launch = await harness.resumeSpec(request, refs.externalRef, options);
    const process = this.process(agentId, request, launch, { generation, tokenFile });
    return {
      runtime: await this.runtime.respawn(refs.runtime, process),
      externalRef: this.located(launch),
      ...(launch.theme && { theme: launch.theme }),
    };
  }

  async signal(refs: AgentRefs, signal: Signal): Promise<void> {
    if (refs.runtime === null) throw new NoTerminal();
    await this.runtime.signal(refs.runtime, signal);
  }

  /**
   * The runtime would refuse to respawn a pane that is gone or still running; this asks first, so
   * a harness's session (a Codex thread, say) is not touched for a respawn that can't happen.
   */
  private async assertExited(ref: RuntimeRef): Promise<void> {
    const pane = (await this.runtime.only(ref.runtime).inventory()).find(
      (e) => e.ref.terminalId === ref.terminalId && e.ref.locator.paneId === ref.locator.paneId,
    );
    if (pane === undefined) throw new StaleIncarnation(ref.terminalId, "gone");
    if (pane.exit === null) throw new ProcessState(ref.terminalId, "exited");
  }

  private harness(request: AgentLaunchRequest): HarnessAdapter {
    const harness = this.opts.harnesses.find((h) => h.id === request.harness);
    if (harness === undefined) throw new UnsupportedHarness(request.harness);
    return harness;
  }

  /**
   * The process an agent's terminal runs: the harness's TUI, with Bazhen's variables, started
   * through the login shell when there is one.
   */
  private process(
    agentId: AgentSessionId,
    request: AgentLaunchRequest,
    launch: HarnessLaunch,
    start: { readonly generation: number; readonly tokenFile: string },
  ): ProcessSpec {
    return {
      argv:
        this.opts.loginShell === undefined
          ? launch.argv
          : loginArgv(this.opts.loginShell, launch.argv),
      cwd: request.cwd,
      env: {
        ...launch.env,
        BAZHEN_AGENT_ID: agentId,
        // Not named for its token: Codex's default shell environment policy strips every
        // variable whose name holds KEY, SECRET or TOKEN from the commands an agent runs.
        BAZHEN_AGENT_AUTH_FILE: start.tokenFile,
        BAZHEN_SOCKET: this.opts.socket,
      },
      generation: start.generation,
      ...(launch.theme && { theme: launch.theme }),
    };
  }

  private located(launch: HarnessLaunch): ExternalRef | null {
    return launch.externalRef && { ...launch.externalRef, environmentId: this.id };
  }
}

/** A harness session id as Claude Code and Codex mint them: a UUID-like word, never a flag. */
const SESSION_ID = /^\w[\w.:-]*$/;

/** The harness session a terminal's tag carries, if it is one of this environment's. */
function harnessSessionOf(
  tag: string | undefined,
  environmentId: EnvironmentId,
): ExternalRef | undefined {
  if (!tag) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(tag);
  } catch {
    return undefined;
  }
  const field = (key: string): unknown =>
    typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;
  const kind = field("kind");
  const id = field("id");
  // A harness gets the id as an argument (`--resume <id>`): one starting with `-` would be a flag.
  if (field("environmentId") !== environmentId || typeof id !== "string" || !SESSION_ID.test(id))
    return undefined;
  if (kind !== "claude-session" && kind !== "codex-thread") return undefined;
  return { environmentId, kind, id };
}

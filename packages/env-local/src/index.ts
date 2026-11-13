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
  RuntimeAdapter,
  RuntimeRef,
  ShellInventoryEntry,
  ShellOpen,
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
  readonly resumable: readonly HarnessId[];
  readonly themes: Readonly<Partial<Record<HarnessId, readonly TuiTheme[]>>>;
  private readonly opts: LocalEnvironmentOptions;

  constructor(opts: LocalEnvironmentOptions) {
    this.id = opts.id;
    this.harnesses = opts.harnesses.map((h) => h.id);
    this.resumable = opts.harnesses.flatMap((h) => (h.resumeSpec === undefined ? [] : [h.id]));
    this.themes = Object.fromEntries(opts.harnesses.map((h) => [h.id, h.themes]));
    this.opts = opts;
  }

  /** `known`'s servers, by their pid and start time, tell a dead server from a lost socket (§7.1). */
  async health(known: readonly RuntimeRef[] = []): Promise<EnvironmentHealth> {
    const { state, version } = await this.opts.runtime.health(known);
    return { state: HEALTH[state], version };
  }

  async inventory(): Promise<AgentInventoryEntry[]> {
    return (await this.opts.runtime.inventory()).flatMap((e) => {
      if (e.tags.kind !== "agent") return [];
      const entry = { agentId: e.tags.agentId, ref: e.ref, dead: e.exit !== null };
      const externalRef = harnessSessionOf(e.tags.harnessSession, this.id);
      return [externalRef === undefined ? entry : { ...entry, externalRef }];
    });
  }

  async shells(): Promise<ShellInventoryEntry[]> {
    return (await this.opts.runtime.inventory()).flatMap((e) =>
      e.tags.kind === "shell" ? [{ ref: e.ref, dead: e.exit !== null }] : [],
    );
  }

  /**
   * The user's shell as an interactive login shell, as a new terminal tab runs it (§4.8). It is
   * told its terminal and Bazhen's socket, never an agent id: a harness started in it by hand is
   * not one of Bazhen's agents, so its hooks do nothing.
   */
  openShell({ terminalId, cwd, linkedAgentId, size, theme }: ShellOpen): Promise<RuntimeRef> {
    return this.opts.runtime.create({
      terminalId,
      tags: linkedAgentId === undefined ? { kind: "shell" } : { kind: "shell", linkedAgentId },
      argv: [this.shell, "-l", "-i"],
      cwd,
      env: { BAZHEN_TERMINAL_ID: terminalId, BAZHEN_SOCKET: this.opts.socket },
      size,
      generation: 0,
      ...(theme && { theme }),
    });
  }

  /**
   * By the process group holding the terminal, not by name: a shell named otherwise than `$SHELL`,
   * as after an rc file's `exec zsh`, is still the shell.
   */
  async shellBusy(ref: RuntimeRef): Promise<string | null> {
    const { command, own } = await this.opts.runtime.foreground(ref);
    // A login shell's process may be named with a leading dash, as `-fish`.
    return own ? null : command.replace(/^-/, "");
  }

  private get shell(): string {
    return this.opts.shell ?? "/bin/sh";
  }

  /** Without a recorded terminal there is nothing to prove gone, so it refuses rather than guess. */
  async close(refs: AgentRefs): Promise<void> {
    if (refs.runtime === null) throw new NoTerminal();
    await this.opts.runtime.close(refs.runtime);
  }

  async gone(refs: AgentRefs): Promise<boolean> {
    if (refs.runtime === null) throw new NoTerminal();
    return this.opts.runtime.gone(refs.runtime);
  }

  onExit(cb: (ref: RuntimeRef, status: ExitStatus) => void): () => void {
    return this.opts.runtime.onExit(cb);
  }

  /**
   * Refuses an agent a terminal already carries, live or dead: an agent has one terminal at a time.
   * Only a reachable runtime is read; with no server running its inventory is empty.
   */
  async launch({ agentId, terminalId, request, options, size }: AgentLaunch): Promise<AgentRefs> {
    const harness = this.harness(request);
    if ((await this.health()).state === "reachable") {
      const carried = (await this.inventory()).some((e) => e.agentId === agentId);
      if (carried) throw new AgentTerminalExists(agentId);
    }
    const launch = await harness.launchSpec(request, options);
    const externalRef = this.located(launch);
    const runtime = await this.opts.runtime.create({
      ...this.process(agentId, request, launch, 0),
      terminalId,
      // Carried on the terminal too: a daemon that dies before recording it can still resume it.
      tags: externalRef
        ? { kind: "agent", agentId, harnessSession: JSON.stringify(externalRef) }
        : { kind: "agent", agentId },
      size,
    });
    return { runtime, externalRef, ...(launch.theme && { theme: launch.theme }) };
  }

  async respawn({
    agentId,
    request,
    options,
    refs,
    generation,
  }: AgentRespawn): Promise<AgentRefs & { readonly runtime: RuntimeRef }> {
    const harness = this.harness(request);
    if (refs.runtime === null) throw new NoTerminal();
    if (harness.resumeSpec === undefined || refs.externalRef === null)
      throw new NotResumable(agentId);
    await this.assertExited(refs.runtime);
    const launch = await harness.resumeSpec(request, refs.externalRef, options);
    const process = this.process(agentId, request, launch, generation);
    return {
      runtime: await this.opts.runtime.respawn(refs.runtime, process),
      externalRef: this.located(launch),
      ...(launch.theme && { theme: launch.theme }),
    };
  }

  async signal(refs: AgentRefs, signal: Signal): Promise<void> {
    if (refs.runtime === null) throw new NoTerminal();
    await this.opts.runtime.signal(refs.runtime, signal);
  }

  /**
   * The runtime would refuse to respawn a pane that is gone or still running; this asks first, so
   * a harness's session (a Codex thread, say) is not touched for a respawn that can't happen.
   */
  private async assertExited(ref: RuntimeRef): Promise<void> {
    const pane = (await this.opts.runtime.inventory()).find(
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
    generation: number,
  ): ProcessSpec {
    return {
      argv:
        this.opts.loginShell === undefined
          ? launch.argv
          : loginArgv(this.opts.loginShell, launch.argv),
      cwd: request.cwd,
      env: { ...launch.env, BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: this.opts.socket },
      generation,
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

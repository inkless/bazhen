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
} from "@bazhen/core";
import type {
  ExitStatus,
  ExternalRef,
  HarnessId,
  RuntimeHealthState,
  Signal,
} from "@bazhen/protocol";
import {
  AgentTerminalExists,
  NoTerminal,
  NotResumable,
  ProcessState,
  StaleIncarnation,
  UnsupportedHarness,
} from "@bazhen/core";

/**
 * `argv` started through the user's login shell. The harness's argv goes in as the shell's own
 * arguments, never inside its command string, so no quoting is involved: fish reads them as
 * `$argv`, and bash, zsh and sh as `"$@"` (after `sh`, which fills `$0`). `exec` keeps the TUI
 * the pane's own process.
 */
export function loginArgv(shell: string, argv: readonly string[]): [string, ...string[]] {
  return shell.split("/").at(-1) === "fish"
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
}

/**
 * The machine Bazhen runs on: agents are terminals in the private runtime, each running one
 * harness's TUI (foundation-design §8.1).
 */
const HEALTH: Record<RuntimeHealthState, EnvironmentHealthState> = {
  healthy: "reachable",
  "not-running": "unknown",
  unreachable: "unreachable",
};

export class LocalEnvironment implements EnvironmentAdapter {
  readonly kind = "local";
  readonly id: EnvironmentId;
  readonly harnesses: readonly HarnessId[];
  readonly resumable: readonly HarnessId[];
  private readonly opts: LocalEnvironmentOptions;

  constructor(opts: LocalEnvironmentOptions) {
    this.id = opts.id;
    this.harnesses = opts.harnesses.map((h) => h.id);
    this.resumable = opts.harnesses.flatMap((h) => (h.resumeSpec === undefined ? [] : [h.id]));
    this.opts = opts;
  }

  /**
   * Only a running server can say an agent is gone (§4.4). No server running says nothing yet:
   * it can't be told apart from a server that died taking its agents, until the server's pid and
   * start time are recorded.
   */
  async health(): Promise<EnvironmentHealth> {
    const { state, version } = await this.opts.runtime.health();
    return { state: HEALTH[state], version };
  }

  async inventory(): Promise<AgentInventoryEntry[]> {
    return (await this.opts.runtime.inventory()).flatMap((e) =>
      e.tags.kind === "agent"
        ? [{ agentId: e.tags.agentId, ref: e.ref, dead: e.exit !== null }]
        : [],
    );
  }

  /** Without a recorded terminal there is nothing to prove gone, so it refuses rather than guess. */
  async close(refs: AgentRefs): Promise<void> {
    if (refs.runtime === null) throw new NoTerminal();
    await this.opts.runtime.close(refs.runtime);
  }

  onExit(cb: (ref: RuntimeRef, status: ExitStatus) => void): () => void {
    return this.opts.runtime.onExit(cb);
  }

  /**
   * Refuses an agent a terminal already carries, live or dead: an agent has one terminal at a time.
   * With no server running there is no terminal to find, so only a reachable runtime is read.
   */
  async launch({ agentId, terminalId, request, size }: AgentLaunch): Promise<AgentRefs> {
    const harness = this.harness(request);
    if ((await this.health()).state === "reachable") {
      const carried = (await this.inventory()).some((e) => e.agentId === agentId);
      if (carried) throw new AgentTerminalExists(agentId);
    }
    const launch = await harness.launchSpec(request);
    const runtime = await this.opts.runtime.create({
      ...this.process(agentId, request, launch, 0),
      terminalId,
      tags: { kind: "agent", agentId },
      size,
    });
    return { runtime, externalRef: this.located(launch) };
  }

  async respawn({
    agentId,
    request,
    refs,
    generation,
  }: AgentRespawn): Promise<AgentRefs & { readonly runtime: RuntimeRef }> {
    const harness = this.harness(request);
    if (refs.runtime === null) throw new NoTerminal();
    if (harness.resumeSpec === undefined || refs.externalRef === null)
      throw new NotResumable(agentId);
    await this.assertExited(refs.runtime);
    const launch = await harness.resumeSpec(request, refs.externalRef);
    const process = this.process(agentId, request, launch, generation);
    return {
      runtime: await this.opts.runtime.respawn(refs.runtime, process),
      externalRef: this.located(launch),
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
    };
  }

  private located(launch: HarnessLaunch): ExternalRef | null {
    return launch.externalRef && { ...launch.externalRef, environmentId: this.id };
  }
}

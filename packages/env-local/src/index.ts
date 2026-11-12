import type {
  AgentInventoryEntry,
  AgentLaunch,
  AgentRefs,
  EnvironmentAdapter,
  EnvironmentHealth,
  EnvironmentId,
  HarnessAdapter,
  RuntimeAdapter,
} from "@bazhen/core";
import type { HarnessId } from "@bazhen/protocol";
import { UnsupportedHarness } from "@bazhen/core";

export interface LocalEnvironmentOptions {
  readonly id: EnvironmentId;
  readonly runtime: RuntimeAdapter;
  readonly harnesses: readonly HarnessAdapter[];
  /** The daemon's Unix socket, handed to every agent as BAZHEN_SOCKET. */
  readonly socket: string;
}

/**
 * The machine Bazhen runs on: agents are terminals in the private runtime, each running one
 * harness's TUI (foundation-design §8.1).
 */
export class LocalEnvironment implements EnvironmentAdapter {
  readonly kind = "local";
  readonly id: EnvironmentId;
  readonly harnesses: readonly HarnessId[];
  private readonly opts: LocalEnvironmentOptions;

  constructor(opts: LocalEnvironmentOptions) {
    this.id = opts.id;
    this.harnesses = opts.harnesses.map((h) => h.id);
    this.opts = opts;
  }

  /** A runtime that answers with no server running is a reachable, empty environment (§4.4). */
  async health(): Promise<EnvironmentHealth> {
    const { state, version } = await this.opts.runtime.health();
    return { state: state === "unreachable" ? "unreachable" : "reachable", version };
  }

  async inventory(): Promise<AgentInventoryEntry[]> {
    return (await this.opts.runtime.inventory()).flatMap((e) =>
      e.tags.kind === "agent" ? [{ agentId: e.tags.agentId, ref: e.ref, dead: e.dead }] : [],
    );
  }

  async launch({ agentId, terminalId, request, size }: AgentLaunch): Promise<AgentRefs> {
    const harness = this.opts.harnesses.find((h) => h.id === request.harness);
    if (harness === undefined) throw new UnsupportedHarness(request.harness);
    const launch = harness.launchSpec(request);
    const runtime = await this.opts.runtime.create({
      terminalId,
      tags: { kind: "agent", agentId },
      argv: launch.argv,
      cwd: request.cwd,
      env: { ...launch.env, BAZHEN_AGENT_ID: agentId, BAZHEN_SOCKET: this.opts.socket },
      size,
    });
    const externalRef = launch.externalRef && { ...launch.externalRef, environmentId: this.id };
    return { runtime, externalRef };
  }
}

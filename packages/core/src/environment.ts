import type { AgentLaunchRequest } from "./agent.ts";
import type { EnvironmentKind, ExternalRef, HarnessId } from "@bazhen/protocol";
import type { AgentSessionId, EnvironmentId, TerminalId } from "./ids.ts";
import type { RuntimeRef, Size } from "./runtime.ts";

/** A launch, with every Bazhen id already minted by the daemon (foundation-design §8.1). */
export interface AgentLaunch {
  readonly agentId: AgentSessionId;
  readonly terminalId: TerminalId;
  readonly request: AgentLaunchRequest;
  readonly size: Size;
}

/** What now runs the agent: its terminal's incarnation and its harness session, where known. */
export interface AgentRefs {
  readonly runtime: RuntimeRef | null;
  readonly externalRef: ExternalRef | null;
}

/** The harness has no adapter in this environment, so the request is refused, never emulated. */
export class UnsupportedHarness extends Error {
  readonly harness: HarnessId;

  constructor(harness: HarnessId) {
    super(`this environment cannot run ${harness}`);
    this.harness = harness;
  }
}

/** The environment could not start the agent; the agent is recorded as failed. */
export class LaunchFailed extends Error {
  readonly agentId: AgentSessionId;

  constructor(agentId: AgentSessionId, cause: unknown) {
    super(`agent ${agentId} failed to launch`, { cause });
    this.agentId = agentId;
  }
}

/** The daemon talks only to environments; no tmux, harness or server concept crosses here. */
export interface EnvironmentAdapter {
  readonly id: EnvironmentId;
  readonly kind: EnvironmentKind;
  /** The harnesses it can run; a launch of any other is refused before anything is recorded. */
  readonly harnesses: readonly HarnessId[];
  launch(launch: AgentLaunch): Promise<AgentRefs>;
}

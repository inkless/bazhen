import type { AgentLaunchRequest } from "./agent.ts";
import type { ExternalRef, HarnessId } from "@bazhen/protocol";

/** How to start one harness's TUI; the local environment turns it into a terminal. */
export interface HarnessLaunch {
  readonly argv: readonly [string, ...string[]];
  /** The harness's own variables, such as CODEX_HOME; never a user value. */
  readonly env: Readonly<Record<string, string>>;
  /** The harness session the launch creates, when it is known before the TUI starts. */
  readonly externalRef: Omit<ExternalRef, "environmentId"> | null;
}

/**
 * One harness inside the local environment (foundation-design §11.1). It never opens a socket
 * or a process, or touches the store.
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  launchSpec(request: AgentLaunchRequest): HarnessLaunch;
}

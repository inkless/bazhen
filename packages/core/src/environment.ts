import type { AgentLaunchRequest } from "./agent.ts";
import type { LaunchOptions } from "./harness.ts";
import type {
  EnvironmentKind,
  ExitStatus,
  ExternalRef,
  HarnessId,
  Signal,
  TuiTheme,
} from "@bazhen/protocol";
import type { AgentSessionId, EnvironmentId, TerminalId } from "./ids.ts";
import type { RuntimeRef, Size } from "./runtime.ts";

export type EnvironmentHealthState =
  | "unknown"
  | "reachable"
  | "unreachable"
  | "auth_failed"
  | "version_unsupported";

export interface EnvironmentHealth {
  readonly state: EnvironmentHealthState;
  readonly version: string | null;
}

/** A Bazhen-launched agent the environment still has, for reconciliation (foundation-design §7). */
export interface AgentInventoryEntry {
  readonly agentId: AgentSessionId;
  readonly ref: RuntimeRef;
  readonly dead: boolean;
  /** The harness session it was launched on, as its terminal carries it, if it does. */
  readonly externalRef?: ExternalRef;
}

/** A launch, with every Bazhen id already minted by the daemon (foundation-design §8.1). */
export interface AgentLaunch {
  readonly agentId: AgentSessionId;
  readonly terminalId: TerminalId;
  readonly request: AgentLaunchRequest;
  readonly options: LaunchOptions;
  readonly size: Size;
}

/** A respawn: the agent as recorded, and the generation its terminal's new incarnation takes. */
export interface AgentRespawn {
  readonly agentId: AgentSessionId;
  readonly request: AgentLaunchRequest;
  readonly options: LaunchOptions;
  readonly refs: AgentRefs;
  readonly generation: number;
}

/** What now runs the agent: its terminal's incarnation and its harness session, where known. */
export interface AgentRefs {
  readonly runtime: RuntimeRef | null;
  readonly externalRef: ExternalRef | null;
  /** The theme its TUI was started for, when one was named. */
  readonly theme?: TuiTheme;
}

/** The harness has no adapter in this environment, so the request is refused, never emulated. */
export class UnsupportedHarness extends Error {
  readonly harness: HarnessId;

  constructor(harness: HarnessId) {
    super(`this environment cannot run ${harness}`);
    this.harness = harness;
  }
}

/** The agent has no terminal to act on, though its state says it should. */
export class NoTerminal extends Error {
  constructor() {
    super("the agent has no terminal recorded");
  }
}

/** The agent has no harness session it can be started again on. */
export class NotResumable extends Error {
  readonly agentId: AgentSessionId;

  constructor(agentId: AgentSessionId) {
    super(`agent ${agentId} has no session to resume`);
    this.agentId = agentId;
  }
}

/** A terminal already carries the agent: an agent has one terminal at a time. */
export class AgentTerminalExists extends Error {
  readonly agentId: AgentSessionId;

  constructor(agentId: AgentSessionId) {
    super(`agent ${agentId} already has a terminal`);
    this.agentId = agentId;
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
  /** The harnesses whose agents can be respawned on their session; a respawn of any other is refused first. */
  readonly resumable: readonly HarnessId[];
  /** The themes each harness it runs can start its TUI in. */
  readonly themes: Readonly<Partial<Record<HarnessId, readonly TuiTheme[]>>>;
  /**
   * Only a reachable environment can say an agent is gone (foundation-design §4.4). `known` are
   * the refs the daemon recorded, by which an environment tells a dead runtime from one it can't
   * reach just now.
   */
  health(known?: readonly RuntimeRef[]): Promise<EnvironmentHealth>;
  inventory(): Promise<AgentInventoryEntry[]>;
  launch(launch: AgentLaunch): Promise<AgentRefs>;
  /** Starts the agent's exited terminal again, on its existing harness session. */
  respawn(respawn: AgentRespawn): Promise<AgentRefs & { readonly runtime: RuntimeRef }>;
  /**
   * Signals the agent's process. A native path, because Ctrl-C through the terminal would be
   * typing (§11.1); an environment that can't signal reports it unsupported.
   */
  signal(refs: AgentRefs, signal: Signal): Promise<void>;
  /** Ends what runs the agent. What the environment positively no longer has counts as ended. */
  close(refs: AgentRefs): Promise<void>;
  /** Whether the environment positively no longer has what ran the agent (RuntimeAdapter.gone). */
  gone(refs: AgentRefs): Promise<boolean>;
  /** Reports every terminal whose process has ended, as the runtime does (RuntimeAdapter.onExit). */
  onExit(cb: (ref: RuntimeRef, status: ExitStatus) => void): () => void;
}

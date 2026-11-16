import type { AgentLaunchRequest, Resumes } from "./agent.ts";
import type { LaunchOptions } from "./harness.ts";
import type {
  EnvironmentKind,
  ExitStatus,
  ExternalRef,
  HarnessId,
  Signal,
  TuiTheme,
} from "@bazhen/protocol";
import type { AgentSessionId, DeviceId, EnvironmentId, TerminalId } from "./ids.ts";
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

/** A Bazhen-opened shell the environment still has, for reconciliation (foundation-design §4.8). */
export interface ShellInventoryEntry {
  readonly ref: RuntimeRef;
  readonly dead: boolean;
  /** The agent its terminal still names, if it does. */
  readonly linkedAgentId?: AgentSessionId;
}

/** What a live shell runs in its foreground, read from process facts (foundation-design §4.8). */
export interface ShellForeground {
  readonly ref: RuntimeRef;
  /** The program's name, as `nvim`; null at the shell's prompt. */
  readonly command: string | null;
  /** The directory the shell is in now; null when it couldn't be read whole. */
  readonly cwd: string | null;
}

/**
 * What a shell needs to report the lines it runs, when the user turned that on: the token only it
 * holds, the hook client it reports through, and the directory of the snippets its rc sources.
 */
export interface ShellIntegration {
  readonly token: string;
  readonly hook: string;
  readonly dir: string;
}

/** A shell to open, its TerminalId minted by the daemon, which recorded it first. */
export interface ShellOpen {
  readonly terminalId: TerminalId;
  readonly cwd: string;
  readonly linkedAgentId?: AgentSessionId;
  readonly size: Size;
  readonly theme?: TuiTheme;
  /**
   * The paired device that opened it, named to the shell as BAZHEN_DEVICE_ID. Advisory: anything
   * running in the shell can change its environment.
   */
  readonly openedBy?: DeviceId;
  readonly integration?: ShellIntegration;
  /** The runtime it is created on, as its open recorded; the environment's default when none. */
  readonly runtime?: string;
}

/**
 * A launch, with every Bazhen id already minted by the daemon (foundation-design §8.1). A relaunch
 * is one too: a new terminal at the agent's next generation, on the session `resume` names, or on
 * a new one when it is null.
 */
export interface AgentLaunch {
  readonly agentId: AgentSessionId;
  readonly terminalId: TerminalId;
  readonly generation: number;
  readonly resume: ExternalRef | null;
  readonly request: AgentLaunchRequest;
  readonly options: LaunchOptions;
  readonly size: Size;
  /** The runtime its terminal is created on, as its launch recorded; the default when none. */
  readonly runtime?: string;
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

/**
 * The harness runs here, but not on the runtime a new terminal would be made on: Codex's TUI is
 * followed from thread to thread by its tmux pane's title, which a holder doesn't report yet.
 */
export class UnsupportedOnRuntime extends UnsupportedHarness {
  readonly runtime: string;

  constructor(harness: HarnessId, runtime: string) {
    super(harness);
    this.message = `${harness} agents can't run on the ${runtime} runtime yet; set runtime.default = "tmux" to start one`;
    this.runtime = runtime;
  }
}

/** Harnesses that can't run on a runtime yet, by runtime. */
const UNSUPPORTED_ON: Readonly<Record<string, readonly HarnessId[]>> = { holder: ["codex"] };

/** Refuses a harness the runtime its new terminal goes to can't run yet. */
export function assertRunsOn(harness: HarnessId, runtime: string): void {
  if (UNSUPPORTED_ON[runtime]?.includes(harness)) throw new UnsupportedOnRuntime(harness, runtime);
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

/**
 * The harness's own server answered that it won't do this, and the message gives its reason in
 * its own words. Unlike a server that can't be reached, asking again won't help until what the
 * message names changes.
 */
export class HarnessRefused extends Error {}

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

  /** `why` is shown to whoever asked, so it carries no secret the cause's own text might hold. */
  constructor(agentId: AgentSessionId, why: string, options?: ErrorOptions) {
    super(`agent ${agentId} failed to launch: ${why}`, options);
    this.agentId = agentId;
  }
}

/** The daemon talks only to environments; no tmux, harness or server concept crosses here. */
export interface EnvironmentAdapter {
  readonly id: EnvironmentId;
  readonly kind: EnvironmentKind;
  /** The harnesses it can run; a launch of any other is refused before anything is recorded. */
  readonly harnesses: readonly HarnessId[];
  /**
   * Whether an agent's harness session can be resumed here, as a respawn or relaunch would: one
   * it says no to is refused first, or relaunched only on a fresh session when that is asked for.
   */
  readonly resumes: Resumes;
  /** The themes each harness it runs can start its TUI in. */
  readonly themes: Readonly<Partial<Record<HarnessId, readonly TuiTheme[]>>>;
  /**
   * The kinds of runtime its terminals run on. Each is read, and its terminals concluded on, by
   * itself: one that can't be read says nothing of another's terminals (design §5.4).
   */
  readonly runtimes: readonly string[];
  /** The runtime a new terminal is created on. */
  readonly defaultRuntime: string;
  /**
   * Only a reachable environment can say an agent is gone (foundation-design §4.4). `known` are
   * the refs the daemon recorded, by which an environment tells a dead runtime from one it can't
   * reach just now. Given `runtime`, only that runtime is read.
   */
  health(known?: readonly RuntimeRef[], runtime?: string): Promise<EnvironmentHealth>;
  /** Given `runtime`, only the agents on that runtime. */
  inventory(runtime?: string): Promise<AgentInventoryEntry[]>;
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
  /** The shells it holds, live or dead, on `runtime` alone if named; an unreadable one throws. */
  shells(runtime?: string): Promise<ShellInventoryEntry[]>;
  openShell(open: ShellOpen): Promise<RuntimeRef>;
  /**
   * What runs in the shell's foreground when it is not the shell itself, such as `nvim`, or null
   * when the shell is at its prompt. Read from process facts, never from the screen.
   */
  shellBusy(ref: RuntimeRef): Promise<string | null>;
  /**
   * The foregrounds of the shells `refs` names, in one read; an unreadable environment throws.
   * Nothing is read for none.
   */
  shellForegrounds(refs: readonly RuntimeRef[]): Promise<ShellForeground[]>;
  /** Makes a linked shell standalone where it runs: its terminal no longer names the agent. */
  unlinkShell(ref: RuntimeRef): Promise<void>;
  /**
   * Types `text` at the shell's prompt as a paste, without Enter (RuntimeAdapter.paste): the only
   * thing the daemon ever types into a terminal (§4.8).
   */
  pasteShell(ref: RuntimeRef, text: string, brackets: boolean): Promise<void>;
  /** Reports every terminal whose process has ended, as the runtime does (RuntimeAdapter.onExit). */
  onExit(cb: (ref: RuntimeRef, status: ExitStatus) => void): () => void;
}

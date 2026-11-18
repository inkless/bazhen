import type { AgentLaunchRequest } from "./agent.ts";
import type { Activity, ExternalRef, HarnessId, TuiTheme } from "@bazhen/protocol";

/**
 * A turn's end that the account's limit may have caused, as its harness reports it: `quota` when
 * the harness names the account's usage limit, `rate` for a rate limit it can't tell from one
 * that passes in moments. Only the daemon, which holds the usage limits the harness last
 * reported, can say whether the agent is `limited` until a reset.
 */
export type LimitStop = "quota" | "rate";

/** What a harness's report says the agent is doing, before the daemon stamps and records it. */
export type HarnessActivity = Pick<Activity, "value" | "detail"> & { readonly limit?: LimitStop };

/** How to start one harness's TUI; the local environment turns it into a terminal. */
export interface HarnessLaunch {
  readonly argv: readonly [string, ...string[]];
  /** The harness's own variables, such as CODEX_HOME; never a user value. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * The theme the TUI is started for, when the launch named one: the one asked for, or the one
   * the harness can draw for if it differs.
   */
  readonly theme?: TuiTheme;
  /** The harness session the launch creates, when it is known before the TUI starts. */
  readonly externalRef: Omit<ExternalRef, "environmentId"> | null;
}

/** What one start of a TUI asks for beyond the agent's launch request; nothing here is stored. */
export interface LaunchOptions {
  /** The background the TUI is shown on; absent, the user's own setting stands. */
  readonly theme?: TuiTheme;
  /** Text added to the harness's own system instructions for this agent, such as its fleet verbs. */
  readonly instructions?: string;
  /**
   * A private file holding `instructions`, for a harness that reads them from one, so they stay
   * out of its arguments.
   */
  readonly instructionsFile?: string;
  /**
   * Whether `instructions` differ from those the agent's last start gave it, for a harness whose
   * session keeps what it was first given across a resume.
   */
  readonly instructionsChanged?: boolean;
  /**
   * The agent's name as it stands at this start, for a harness that shows or addresses its
   * session by one. A rename reaches the harness only at its next start.
   */
  readonly name?: string;
  /** How many tokens of context the harness compacts at; absent, its own setting stands. */
  readonly compactWindowTokens?: number;
}

/**
 * A harness's own server, reached over a connection the daemon owns, such as Codex's app-server
 * (foundation-design §8.1, §5.8). The adapter exchanges JSON-RPC messages; it never sees the
 * socket.
 */
export interface HarnessChannelPort {
  /** One request's result; a JSON-RPC error rejects. */
  request(method: string, params: unknown): Promise<unknown>;
}

/**
 * One harness inside the local environment (foundation-design §11.1). It never opens a socket
 * or a process, or touches the store, except through the ports it is given. Preparing a launch
 * may create the harness's own session, as Codex's thread is, before the TUI starts.
 */
export interface HarnessAdapter {
  readonly id: HarnessId;
  /** The themes it can start its TUI in; asked for another, it starts in one of these. */
  readonly themes: readonly TuiTheme[];
  launchSpec(request: AgentLaunchRequest, options: LaunchOptions): Promise<HarnessLaunch>;
  /**
   * How to start the TUI again on the agent's existing harness session. A harness without it
   * can't be respawned: a fresh session would rebind the agent (foundation-design §3.1).
   */
  resumeSpec?(
    request: AgentLaunchRequest,
    session: Omit<ExternalRef, "environmentId">,
    options: LaunchOptions,
  ): Promise<HarnessLaunch>;
  /**
   * Whether `resumeSpec` would find the session, by what its hooks reported of it (`transcript`,
   * null when none did). Without it, every session with `resumeSpec` can be resumed.
   */
  canResume?(session: { readonly transcript: string | null }): boolean;
}

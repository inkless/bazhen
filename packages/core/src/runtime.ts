import type { ExitStatus, RuntimeHealthState, Signal } from "@bazhen/protocol";
import type { AgentSessionId, TerminalId } from "./ids.ts";

export interface Size {
  readonly cols: number;
  readonly rows: number;
}

/**
 * What the daemon writes into the runtime beside the TerminalId, so reconciliation can rebuild
 * the join from the runtime alone (foundation-design §3.2).
 */
export type TerminalTags =
  | { readonly kind: "agent"; readonly agentId: AgentSessionId }
  | { readonly kind: "shell"; readonly linkedAgentId?: AgentSessionId };

export interface TerminalSpec {
  readonly terminalId: TerminalId;
  readonly tags: TerminalTags;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  /** Bazhen's own variables for this terminal only; never a user value (foundation-design §9.5). */
  readonly env: Readonly<Record<string, string>>;
  readonly size: Size;
  /** The incarnation this starts: 0 at create, the next one at each respawn (§3). */
  readonly generation: number;
}

/** Locates one runtime incarnation of a terminal. Diagnostic and routing only, never identity. */
export interface RuntimeRef {
  readonly terminalId: TerminalId;
  readonly runtime: string;
  readonly locator: Readonly<Record<string, string>>;
}

export interface RuntimeHealth {
  readonly state: RuntimeHealthState;
  readonly version: string | null;
}

export interface RuntimeInventoryEntry {
  readonly ref: RuntimeRef;
  readonly tags: TerminalTags;
  /** How the terminal's process ended, or null while it runs. */
  readonly exit: ExitStatus | null;
}

/**
 * The runtime no longer holds the incarnation a ref names. tmux reuses its session and pane
 * numbers, so a ref is acted on only after its server, pane and process are found unchanged
 * (foundation-design §3, §7.1).
 */
export class StaleIncarnation extends Error {
  readonly terminalId: TerminalId;
  readonly reason: "gone" | "server-replaced" | "pane-replaced" | "process-replaced" | "unnumbered";

  constructor(terminalId: TerminalId, reason: StaleIncarnation["reason"]) {
    super(`terminal ${terminalId}: ${reason}`);
    this.terminalId = terminalId;
    this.reason = reason;
  }
}

/**
 * The generation `ref` recorded is the one the runtime holds now (`current`). A ref without one
 * can't be checked, so it is refused rather than acted on.
 */
export function assertSameGeneration(ref: RuntimeRef, current: string | undefined): void {
  const recorded = ref.locator.generation;
  if (!recorded) throw new StaleIncarnation(ref.terminalId, "unnumbered");
  if (recorded !== current) throw new StaleIncarnation(ref.terminalId, "process-replaced");
}

/** The right incarnation, but its process is not in the state the request needs. */
export class ProcessState extends Error {
  readonly terminalId: TerminalId;
  readonly expected: "running" | "exited";

  constructor(terminalId: TerminalId, expected: ProcessState["expected"]) {
    super(`terminal ${terminalId}: its process is not ${expected}`);
    this.terminalId = terminalId;
    this.expected = expected;
  }
}

export interface RuntimeStream {
  /** The size the client attached at; the runtime picks it when none was asked for. */
  readonly size: Size;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  write(bytes: Uint8Array): void;
  resize(size: Size): Promise<void>;
  /** Whether the program is drawing on its alternate screen, read from the runtime. */
  alternateScreen(): Promise<boolean>;
  /** Must release every OS handle the stream holds. */
  close(): void;
}

/** The runtime has no terminal where the reference points: it closed, or was never there. */
export class TerminalNotFound extends Error {
  readonly ref: RuntimeRef;

  constructor(ref: RuntimeRef, cause?: unknown) {
    super(`no running terminal ${ref.terminalId}`, { cause });
    this.name = "TerminalNotFound";
    this.ref = ref;
  }
}

/** A runtime client just opened, and what it can't redraw: the history above its screen. */
export interface Attached {
  readonly stream: RuntimeStream;
  /**
   * The history above the screen as the client attached, oldest first: lines separated by `\n`,
   * with their SGR attributes, and empty for a program on its alternate screen. Read after the
   * terminal took the client's size, which can push screen lines into it, and before the client
   * draws the screen. Read on demand only, never polled (foundation-design §4.2, §5.9).
   */
  readonly history: string;
  /** Whether the program was on its alternate screen as the client attached. */
  readonly alternate: boolean;
}

export interface RuntimeAdapter {
  readonly kind: string;
  health(): Promise<RuntimeHealth>;
  inventory(): Promise<RuntimeInventoryEntry[]>;
  create(spec: TerminalSpec): Promise<RuntimeRef>;
  /**
   * Opens a client at `size`, or, given null, at whatever size the terminal already has, with up
   * to `historyLines` of the history above its screen.
   */
  attach(ref: RuntimeRef, size: Size | null, historyLines: number): Promise<Attached>;
  /** Ends the terminal. A terminal the runtime positively no longer has counts as closed. */
  close(ref: RuntimeRef): Promise<void>;
  /** Starts a new process in a terminal whose process has exited, and returns the new ref. */
  respawn(ref: RuntimeRef, spec: TerminalSpec): Promise<RuntimeRef>;
  /** Signals the terminal's process and its process group. */
  signal(ref: RuntimeRef, signal: Signal): Promise<void>;
  /**
   * Reports every dead terminal on every check, so the caller drops repeats and stale
   * incarnations by the generation in the ref. A cause first reported unknown may be named by a
   * later report, never the other way. Returns the unsubscribe function.
   */
  onExit(cb: (ref: RuntimeRef, status: ExitStatus) => void): () => void;
}

/** The PTY seam: the only place a PTY library is named. */
export interface PtyProcess {
  onData(cb: (bytes: Uint8Array) => void): void;
  onExit(cb: (code: number) => void): void;
  write(bytes: Uint8Array): void;
  resize(size: Size): void;
  kill(): void;
}

export interface PtySpawner {
  spawn(
    argv: readonly [string, ...string[]],
    size: Size,
    env: Readonly<Record<string, string>>,
  ): PtyProcess;
}

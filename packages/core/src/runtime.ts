import type { ExitStatus, RuntimeHealthState, Signal, TuiTheme } from "@bazhen/protocol";
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
  | {
      readonly kind: "agent";
      readonly agentId: AgentSessionId;
      /**
       * The harness session the agent was launched on, opaque here, so a daemon that died before
       * recording it can still resume it.
       */
      readonly harnessSession?: string;
    }
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
  /**
   * The theme its process starts for, whose text and background a program that asks is told from
   * its first query on; none, and the runtime says nothing of its own.
   */
  readonly theme?: TuiTheme;
}

/** What a terminal runs: a respawn keeps the terminal, its tags and its size, and replaces this. */
export type ProcessSpec = Pick<TerminalSpec, "argv" | "cwd" | "env" | "generation" | "theme">;

/** Locates one runtime incarnation of a terminal. Diagnostic and routing only, never identity. */
export interface RuntimeRef {
  readonly terminalId: TerminalId;
  readonly runtime: string;
  readonly locator: Readonly<Record<string, string>>;
}

export interface Foreground {
  /** The foreground process's name, as the OS reports it, such as `nvim` or `-zsh`. */
  readonly command: string;
  /** The terminal's own process leads the foreground: nothing it started holds it. */
  readonly own: boolean;
}

/** A live terminal's foreground, as one read of every terminal reports it. */
export interface TerminalForeground extends Foreground {
  readonly ref: RuntimeRef;
  /** The directory the terminal's own process is in now; null when it couldn't be read whole. */
  readonly cwd: string | null;
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

/**
 * The runtime no longer shows the terminal, but the server it was made on may still run it, its
 * socket deleted or taken by another, so it can't be called ended (foundation-design §7.1).
 */
export class TerminalUnconfirmed extends Error {
  readonly terminalId: TerminalId;

  constructor(terminalId: TerminalId, cause: unknown) {
    super(`terminal ${terminalId}: its server may still be running it`, { cause });
    this.terminalId = terminalId;
  }
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
  /**
   * The stream is over: the terminal ended, or the runtime lost its connection to it, or, for a
   * snapshot client, it could no longer deliver every byte in order. A close the consumer didn't
   * ask for, of a terminal that still runs, is for it to attach again.
   */
  onClose(cb: () => void): void;
  write(bytes: Uint8Array): void;
  resize(size: Size): Promise<void>;
  /**
   * Each time the program moves to or from its alternate screen, from the state `Attached`
   * reported, and never twice the same way in a row. A runtime that only learns of a switch by
   * asking may report it before or after the output that made it reaches the stream, and a
   * respawn's return to the main screen only once the new process prints.
   */
  onAlternate(cb: (alternate: boolean) => void): void;
  /**
   * Trouble its views should hear of, after which the stream carries on: a failure that ends it
   * closes it instead. One that keeps failing is reported once, until it succeeds again.
   */
  onFailure(cb: (failure: StreamFailure) => void): void;
  /**
   * A snapshot client's terminal has a new process, the generation given: called before its first
   * byte. The consumer applies `RESPAWN_RESET`, as the runtime did. A client that redraws, as
   * tmux's does, is never told: its runtime redraws it instead.
   */
  onRespawn(cb: (generation: number) => void): void;
  /** Must release every OS handle the stream holds. */
  close(): void;
}

/**
 * What a respawn does to a snapshot runtime's terminal before the next process starts: back to
 * its main screen, every mode as a fresh terminal has it, and the screen cleared, its history
 * kept.
 */
export const RESPAWN_RESET =
  "\x1b[?1049l\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l\x1b[H\x1b[2J";

/** What failed, as a few words such as `screen check`, and the error it failed with. */
export interface StreamFailure {
  readonly what: string;
  readonly cause: unknown;
}

/**
 * A runtime client just opened. Either it redraws the screen itself and the history above it is
 * read beside it, or the runtime hands over the whole state at once.
 */
export type Attached = HistoryAttached | SnapshotAttached;

interface AttachedClient {
  readonly stream: RuntimeStream;
  /** Whether the program was on its alternate screen as the client attached. */
  readonly alternate: boolean;
}

/** A client whose first output redraws the screen, but can't redraw the history above it. */
export interface HistoryAttached extends AttachedClient {
  readonly kind: "history";
  /**
   * The history above the screen as the client attached, oldest first: lines separated by `\n`,
   * with their SGR attributes, and empty for a program on its alternate screen. Read after the
   * terminal took the client's size, which can push screen lines into it, and before the client
   * draws the screen. Read on demand only, never polled (foundation-design §4.2, §5.9).
   */
  readonly history: string;
}

/** A client whose stream carries on exactly where its snapshot ends. */
export interface SnapshotAttached extends AttachedClient {
  readonly kind: "snapshot";
  /**
   * VT bytes that rebuild the screen, the history above it, the cursor and the modes exactly as
   * they were after `offset` bytes of output. The stream's bytes are the ones after them, none
   * missed or repeated; a stream that can't keep to that closes. They only set state and never
   * ask the terminal anything, so a terminal that replays them has nothing to answer.
   */
  readonly vt: Uint8Array;
  /**
   * Bytes the process the ref names has printed, from 0 at its start. The stream outlives a
   * respawn, and goes on with the same terminal, the next process's output counted from 0 again.
   * At most `Number.MAX_SAFE_INTEGER`.
   */
  readonly offset: number;
}

export interface RuntimeAdapter {
  readonly kind: string;
  /**
   * `not-running` only when no server answers and none of the servers `recorded` names still
   * runs. One that runs with its socket gone is `unreachable`, and is asked to recreate it
   * (foundation-design §7.1).
   */
  health(recorded?: readonly RuntimeRef[]): Promise<RuntimeHealth>;
  /** The terminals the server holds: none when no server runs. An unreadable server throws. */
  inventory(): Promise<RuntimeInventoryEntry[]>;
  create(spec: TerminalSpec): Promise<RuntimeRef>;
  /**
   * Opens a client at `size`, or, given null, at whatever size the terminal already has, with up
   * to `historyLines` of the history above its screen. A runtime that keeps a depth of its own per
   * terminal may ignore `historyLines`.
   */
  attach(ref: RuntimeRef, size: Size | null, historyLines: number): Promise<Attached>;
  /**
   * Ends the terminal. A terminal the runtime positively no longer has counts as closed; one whose
   * server may still run it is `TerminalUnconfirmed`.
   */
  close(ref: RuntimeRef): Promise<void>;
  /**
   * Whether the runtime positively no longer has the terminal: nothing carries it, and the server
   * it was made on answers or is provably gone. Close and reconciliation both go by this.
   */
  gone(ref: RuntimeRef): Promise<boolean>;
  /** Starts a new process in a terminal whose process has exited, and returns the new ref. */
  respawn(ref: RuntimeRef, spec: ProcessSpec): Promise<RuntimeRef>;
  /**
   * What holds the terminal's foreground, from process facts: whether it is the terminal's own
   * process, as a shell at its prompt is, and the name of the process that leads it. A terminal
   * whose process has exited is `ProcessState`.
   */
  foreground(ref: RuntimeRef): Promise<Foreground>;
  /**
   * The foregrounds of the live terminals among `terminalIds`, in one read, never a screen's. An
   * unreadable server throws; a terminal whose processes can't be read is left out.
   */
  foregrounds(terminalIds: ReadonlySet<string>): Promise<TerminalForeground[]>;
  /** Drops a shell terminal's agent link from its tags, so a reconcile never links it again. */
  unlink(ref: RuntimeRef): Promise<void>;
  /** Signals the terminal's process and its process group. */
  signal(ref: RuntimeRef, signal: Signal): Promise<void>;
  /**
   * Reports every dead terminal on every check, so the caller drops repeats and stale
   * incarnations by the generation in the ref. A cause first reported unknown may be named by a
   * later report, never the other way. Returns the unsubscribe function.
   */
  onExit(cb: (ref: RuntimeRef, status: ExitStatus) => void): () => void;
  /**
   * A shell command a human can paste to attach their own terminal emulator to the terminal, for
   * when no Bazhen client works. Only formatted, never run by the daemon.
   */
  attachCommand(ref: RuntimeRef): string;
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

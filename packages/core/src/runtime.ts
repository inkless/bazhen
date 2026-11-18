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
  /** How many lines of history above its screen it keeps, for as long as it runs. */
  readonly historyLines: number;
  /**
   * The kind of runtime it is created on, which a routed runtime sends it to; none, and its
   * default. A runtime of one kind ignores it.
   */
  readonly runtime?: string;
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

/** What one read of a runtime found of the protocol each of its terminals is served in. */
export interface Compatibility {
  /** Each terminal this build can't fully serve, with the versions what runs it speaks. */
  readonly outdated: ReadonlyMap<TerminalId, readonly string[]>;
  /** The terminals served in full, which need no restart. */
  readonly served: ReadonlySet<TerminalId>;
}

export interface RuntimeHealth {
  readonly state: RuntimeHealthState;
  readonly version: string | null;
  /** Defects of this runtime's version that Bazhen works around, and what each costs. */
  readonly workarounds?: readonly string[];
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

/** The locator keys that name a terminal's process, which a respawn changes; the rest name what runs it. */
const PROCESS_KEYS = new Set(["generation", "childPid", "childStart", "panePid"]);

const GENERATION = /^(0|[1-9]\d*)$/;

/**
 * `found` is a later process of the terminal `recorded` names, run by the same holder or server:
 * one the daemon didn't issue when `recorded` is the latest it did. A generation that isn't a
 * whole number the daemon can count, as it records one, proves nothing.
 */
export function laterGeneration(recorded: RuntimeRef, found: RuntimeRef): boolean {
  const before = recorded.locator.generation ?? "";
  const after = found.locator.generation ?? "";
  if (!GENERATION.test(before) || !GENERATION.test(after)) return false;
  if (found.terminalId !== recorded.terminalId || found.runtime !== recorded.runtime) return false;
  const keys = new Set([...Object.keys(recorded.locator), ...Object.keys(found.locator)]);
  for (const key of keys) {
    if (!PROCESS_KEYS.has(key) && recorded.locator[key] !== found.locator[key]) return false;
  }
  if (!Number.isSafeInteger(Number(before)) || !Number.isSafeInteger(Number(after))) return false;
  return Number(after) > Number(before);
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

/**
 * What runs the terminal is there but can't be reached just now: it refuses this user's
 * connections, or doesn't answer in time. Nothing is known of the terminal, so asking again may
 * work, and it is neither ended nor unconfirmed.
 */
export class RuntimeUnreachable extends Error {
  readonly terminalId: TerminalId;

  constructor(terminalId: TerminalId, cause: unknown) {
    super(`terminal ${terminalId}: what runs it can't be reached`, { cause });
    this.terminalId = terminalId;
  }
}

/**
 * What runs the terminal answers, but in no protocol this build speaks, so it can be neither
 * served nor ended from here: it runs until its own process is ended (design §4.7).
 */
export class TerminalUnservable extends TerminalUnconfirmed {
  readonly protocol: readonly string[];
  /** The holder's pid as the terminal's ref recorded it; null when it recorded none. */
  readonly holderPid: number | null;

  constructor(terminalId: TerminalId, protocol: readonly string[], holderPid: number | null) {
    super(terminalId, new Error(`its holder speaks only ${protocol.join(", ")}`));
    this.message = `terminal ${terminalId}: its holder speaks only ${protocol.join(", ")}, which this build doesn't`;
    this.protocol = protocol;
    this.holderPid = holderPid;
  }
}

/** The runtime can't do what was asked for any terminal it runs. */
export class UnsupportedRuntime extends Error {}

/**
 * The terminal's server predates what was asked of it; restarting the terminal starts it on one
 * that has it.
 */
export class TerminalPredates extends Error {
  readonly terminalId: TerminalId;

  constructor(terminalId: TerminalId, what: string) {
    super(`terminal ${terminalId} runs on a holder that predates ${what}: restart it to use them`);
    this.terminalId = terminalId;
  }
}

/** The terminal's screen can't be read just now, as when its server has lost it. */
export class ScreenUnreadable extends Error {
  readonly terminalId: TerminalId;

  constructor(terminalId: TerminalId, reason: string) {
    super(`terminal ${terminalId}'s screen can't be read: ${reason}`);
    this.terminalId = terminalId;
  }
}

/** A terminal's screen as plain text: what `RuntimeAdapter.screen` reads. */
export interface ScreenText {
  /**
   * The rows of history read, then the screen shown: a line a row, each ended by a newline, the
   * blanks a row ends in and the empty rows the screen ends in left out. It holds no control
   * character but those newlines.
   */
  readonly text: string;
  /** How many rows of history it starts with. */
  readonly history: number;
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
   * The stream is over: its consumer closed it, the terminal ended, or the runtime lost its
   * connection to it, or, for a snapshot client, it could no longer deliver every byte in order. A
   * close the consumer didn't ask for, of a terminal that still runs, is for it to attach again.
   */
  onClose(cb: (why: StreamEnd) => void): void;
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
   * A snapshot client's terminal has a new process, the generation given, always higher than the
   * last: called before its first byte. The consumer applies `RESPAWN_RESET`, as the runtime did.
   * A client that redraws, as tmux's does, is never told: its runtime redraws it instead.
   */
  onRespawn(cb: (generation: number) => void): void;
  /** Must release every OS handle the stream holds. */
  close(): void;
}

/**
 * What a respawn does to a snapshot runtime's terminal before the next process starts: back to
 * its main screen, every mode and colour as a fresh terminal has it, and the screen cleared, its
 * history kept.
 */
export const RESPAWN_RESET =
  "\x1b[?1049l\x1b[!p\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1004l\x1b[?2004l" +
  "\x1b]104\x07\x1b]110\x07\x1b]111\x07\x1b]112\x07\x1b[H\x1b[2J";

/**
 * Why a stream closed: `behind` only for a snapshot client that could no longer deliver every
 * byte in order, which attaching again recovers from; `ended` for anything else.
 */
export type StreamEnd = "behind" | "ended";

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
  /**
   * How many lines of history above its screen the terminal keeps, as the runtime reports it: the
   * depth it was made with, whatever the daemon's configuration says now.
   */
  readonly historyLines: number;
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

/** A terminal's whole state as of one point in its output. */
export interface Snapshot {
  /**
   * VT bytes that rebuild the screen, at the terminal's size then, the history above it, the cursor
   * and the modes exactly as they were after `offset` bytes of output. They only set state and
   * never ask the terminal anything, so a terminal that replays them has nothing to answer.
   */
  readonly vt: Uint8Array;
  /**
   * Bytes the process of `generation` had printed, from 0 at its start. At most
   * `Number.MAX_SAFE_INTEGER`.
   */
  readonly offset: number;
  /**
   * The process's generation, as its `ProcessSpec` and `onRespawn` give it. Each respawn's is
   * higher than the last, so positions order by generation, then offset.
   */
  readonly generation: number;
}

/**
 * A stream whose bytes carry on exactly where its snapshot ends, none missed or repeated; one that
 * can't keep to that closes. It outlives a respawn, and goes on with the same terminal, the next
 * process's output counted from 0 again.
 */
export interface SnapshotStream extends RuntimeStream {
  /**
   * The terminal as it is now, its process running or exited. Its (generation, offset) is no
   * earlier than the stream's position at the call, the generation and offset of the next byte
   * it would deliver, and no later than that position as it resolves: every byte before its
   * offset, and any respawn before it, has reached the stream's callbacks by then. Several may be
   * outstanding at once. Rejects if the stream closes first, and only once its `onClose`
   * callbacks have run, so a consumer can tell the two apart; any other failure rejects and leaves
   * the stream open.
   */
  snapshot(): Promise<Snapshot>;
}

/** A client that opened on a snapshot, which its stream carries on from. */
export interface SnapshotAttached extends Snapshot {
  readonly kind: "snapshot";
  readonly stream: SnapshotStream;
  /** Whether the program was on its alternate screen as the client attached. */
  readonly alternate: boolean;
  /**
   * How many lines of history above its screen the terminal keeps, as the runtime reports it: the
   * depth it was made with, whatever the daemon's configuration says now.
   */
  readonly historyLines: number;
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
  /**
   * Which terminals this build serves in full, and which run where it can't, such as on a holder
   * of another protocol major, with the versions what runs those speaks; they need a restart to
   * be served in full. Absent from a runtime whose terminals are always served in full.
   */
  compatibility?(): Promise<Compatibility>;
  create(spec: TerminalSpec): Promise<RuntimeRef>;
  /**
   * Opens a client at `size`, or, given null, at whatever size the terminal already has, with the
   * history the terminal keeps above its screen.
   */
  attach(ref: RuntimeRef, size: Size | null): Promise<Attached>;
  /**
   * Ends the terminal. A terminal the runtime positively no longer has counts as closed; one whose
   * server may still run it is `TerminalUnconfirmed`; one whose server runs but can't be reached
   * just now is `RuntimeUnreachable`.
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
   * The screen shown, the alternate one while it is up, as plain text after the newest `history`
   * rows of the primary screen's history, read without input or a lease and whether or not the
   * terminal's process has exited. A runtime that can't read screens is `UnsupportedRuntime`.
   */
  screen(ref: RuntimeRef, history: number): Promise<ScreenText>;
  /**
   * The foregrounds of the live terminals among `terminalIds`, in one read, never a screen's. An
   * unreadable server throws; a terminal whose processes can't be read is left out.
   */
  foregrounds(terminalIds: ReadonlySet<string>): Promise<TerminalForeground[]>;
  /**
   * The title the terminal's program last set, as a Codex TUI sets it to its thread: empty after a
   * respawn until the new process sets one, so no title outlives the process that set it.
   */
  title(ref: RuntimeRef): Promise<string>;
  /** Drops a shell terminal's agent link from its tags, so a reconcile never links it again. */
  unlink(ref: RuntimeRef): Promise<void>;
  /**
   * Types `text` into the terminal's process as a paste, without Enter: marked as one with the
   * bracketed-paste sequences when `brackets` is true, else only if the program has asked for
   * bracketed paste. Text holding a C0 or C1 control character or DEL, ESC among them, is
   * refused with a RangeError. The text is never in a log or a process's arguments. A terminal whose process has
   * exited is `ProcessState`; one replaced since `ref` is `StaleIncarnation`.
   */
  paste(ref: RuntimeRef, text: string, brackets: boolean): Promise<void>;
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
  /**
   * The path of the PTY's terminal device while this process holds the master open: no other PTY
   * can have it then. Undefined once the master is closed here, when the name may be reused.
   */
  readonly tty: string | undefined;
  onData(cb: (bytes: Uint8Array) => void): void;
  onExit(cb: (code: number) => void): void;
  write(bytes: Uint8Array): void;
  resize(size: Size): void;
  /** Closes the PTY, as a terminal closing does: never a signal to the child by its pid. */
  hangUp(): void;
}

export interface PtySpawner {
  spawn(
    argv: readonly [string, ...string[]],
    size: Size,
    env: Readonly<Record<string, string>>,
  ): PtyProcess;
}

import type { RuntimeHealthState } from "@bazhen/protocol";
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
  readonly dead: boolean;
  readonly exitStatus: number | null;
}

export interface RuntimeStream {
  /** The size the client attached at; the runtime picks it when none was asked for. */
  readonly size: Size;
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  write(bytes: Uint8Array): void;
  resize(size: Size): Promise<void>;
  /** Must release every OS handle the stream holds. */
  close(): void;
}

/** A runtime client just opened, and what it can't redraw: the history above its screen. */
export interface Attached {
  readonly stream: RuntimeStream;
  /**
   * The history above the screen as the client attached, oldest first, as plain VT bytes: read
   * after the terminal took the client's size, which can push screen lines into it, and before the
   * client draws the screen. Read on demand only, never polled (foundation-design §4.2, §5.9).
   */
  readonly history: string;
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
  close(ref: RuntimeRef): Promise<void>;
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

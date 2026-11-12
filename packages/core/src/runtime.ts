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
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  write(bytes: Uint8Array): void;
  resize(size: Size): Promise<void>;
  /** Must release every OS handle the stream holds. */
  close(): void;
}

export interface RuntimeAdapter {
  readonly kind: string;
  health(): Promise<RuntimeHealth>;
  inventory(): Promise<RuntimeInventoryEntry[]>;
  create(spec: TerminalSpec): Promise<RuntimeRef>;
  attach(ref: RuntimeRef, size: Size): Promise<RuntimeStream>;
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

import type { RuntimeHealthState } from "@bazhen/protocol";
import type { TerminalId } from "./ids.ts";

export interface Size {
  readonly cols: number;
  readonly rows: number;
}

export interface TerminalSpec {
  readonly terminalId: TerminalId;
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
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
  readonly dead: boolean;
  readonly exitStatus: number | null;
}

export interface RuntimeStream {
  onData(cb: (bytes: Uint8Array) => void): void;
  onClose(cb: () => void): void;
  write(bytes: Uint8Array): void;
  resize(size: Size): void;
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

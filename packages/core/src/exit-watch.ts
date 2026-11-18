import type { RuntimeRef } from "./runtime.ts";
import type { ExitStatus } from "@bazhen/protocol";

// Every runtime Bazhen runs on has these; core type-checks against no platform's globals.
declare function setInterval(callback: () => void, ms: number): unknown;
declare function clearInterval(timer: unknown): void;

export interface DeadTerminal {
  readonly ref: RuntimeRef;
  readonly status: ExitStatus;
}

type Listener = (ref: RuntimeRef, status: ExitStatus) => void;

export interface ExitWatchOptions {
  readonly read: () => Promise<readonly DeadTerminal[]>;
  readonly intervalMs: number;
  /** Whether a tick reads at all; without it, every tick does. */
  readonly active?: () => boolean;
  /** Where a failed read or a throwing listener goes; neither stops the timer or the others. */
  readonly onError: (err: unknown) => void;
}

/**
 * Polls for dead terminals while anyone listens and it is active, and reports every one on every tick, so a
 * listener that missed one, or a death the runtime only learns of by asking, is still told.
 */
export class ExitWatch {
  private readonly opts: ExitWatchOptions;
  private readonly listeners = new Set<Listener>();
  private timer: unknown;
  private reading = false;

  constructor(opts: ExitWatchOptions) {
    this.opts = opts;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.timer ??= setInterval(() => void this.tick(), this.opts.intervalMs);
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size > 0) return;
      clearInterval(this.timer);
      this.timer = undefined;
    };
  }

  private async tick(): Promise<void> {
    if (this.reading) return;
    this.reading = true;
    try {
      if (this.opts.active?.() === false) return;
      for (const { ref, status } of await this.opts.read())
        for (const listener of this.listeners) this.call(listener, ref, status);
    } catch (err) {
      this.opts.onError(err);
    } finally {
      this.reading = false;
    }
  }

  private call(listener: Listener, ref: RuntimeRef, status: ExitStatus): void {
    try {
      listener(ref, status);
    } catch (err) {
      this.opts.onError(err);
    }
  }
}

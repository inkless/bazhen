import type { RuntimeRef } from "./runtime.ts";
import type { ExitStatus } from "@bazhen/protocol";

// Every runtime Bazhen runs on has these; core type-checks against no platform's globals.
declare function setInterval(callback: () => void, ms: number): unknown;
declare function clearInterval(timer: unknown): void;

/** A terminal's current process: how it ended once it has, null while it runs. */
export interface ObservedProcess {
  readonly ref: RuntimeRef;
  readonly exit: ExitStatus | null;
}

export type ProcessListener = (ref: RuntimeRef, exit: ExitStatus | null) => void;

export interface ProcessWatchOptions {
  readonly read: () => Promise<readonly ObservedProcess[]>;
  readonly intervalMs: number;
  /** Whether a tick reads at all; without it, every tick does. */
  readonly active?: () => boolean;
  /** Where a failed read or a throwing listener goes; neither stops the timer or the others. */
  readonly onError: (err: unknown) => void;
}

/**
 * Polls the terminals while anyone listens and it is active, and reports each one's process on
 * every tick, so a listener that missed a report, or a change the runtime only learns of by asking,
 * is still told.
 */
export class ProcessWatch {
  private readonly opts: ProcessWatchOptions;
  private readonly listeners = new Set<ProcessListener>();
  private timer: unknown;
  private reading = false;

  constructor(opts: ProcessWatchOptions) {
    this.opts = opts;
  }

  subscribe(listener: ProcessListener): () => void {
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
      for (const { ref, exit } of await this.opts.read())
        for (const listener of this.listeners) this.call(listener, ref, exit);
    } catch (err) {
      this.opts.onError(err);
    } finally {
      this.reading = false;
    }
  }

  private call(listener: ProcessListener, ref: RuntimeRef, exit: ExitStatus | null): void {
    try {
      listener(ref, exit);
    } catch (err) {
      this.opts.onError(err);
    }
  }
}

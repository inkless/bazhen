import type { RuntimeRef } from "@bazhen/core";
import type { ExitStatus } from "@bazhen/protocol";

export interface DeadTerminal {
  readonly ref: RuntimeRef;
  readonly status: ExitStatus;
}

type Listener = (ref: RuntimeRef, status: ExitStatus) => void;

export interface ExitWatchOptions {
  readonly read: () => Promise<readonly DeadTerminal[]>;
  readonly intervalMs: number;
  /**
   * How long a death of unknown cause waits before it is reported as unknown. The runtime can
   * learn of a death before it learns how the process ended; tmux 3.4 sometimes never learns.
   */
  readonly unknownAfterMs: number;
  /** Where a failed read or a throwing listener goes; neither stops the timer or the others. */
  readonly onError: (err: unknown) => void;
}

/**
 * Polls for dead terminals while anyone listens, and reports every one on every tick. tmux could
 * announce a death only through a `pane-died` hook running a shell command back into Bazhen,
 * which the argv-only rule forbids (foundation-design §8.2).
 */
export class ExitWatch {
  private readonly opts: ExitWatchOptions;
  private readonly listeners = new Set<Listener>();
  /** When each death of still-unknown cause was first seen, keyed by its ref. */
  private unexplained = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
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
      for (const { ref, status } of this.settled(await this.opts.read()))
        for (const listener of this.listeners) this.call(listener, ref, status);
    } catch (err) {
      this.opts.onError(err);
    } finally {
      this.reading = false;
    }
  }

  /** The deaths to report now: each known one, and each unknown one that has waited long enough. */
  private settled(dead: readonly DeadTerminal[]): DeadTerminal[] {
    const now = Date.now();
    const unexplained = new Map<string, number>();
    const ready = dead.filter(({ ref, status }) => {
      if (status.type !== "unknown") return true;
      const key = JSON.stringify(ref);
      const since = this.unexplained.get(key) ?? now;
      unexplained.set(key, since);
      return now - since >= this.opts.unknownAfterMs;
    });
    this.unexplained = unexplained;
    return ready;
  }

  private call(listener: Listener, ref: RuntimeRef, status: ExitStatus): void {
    try {
      listener(ref, status);
    } catch (err) {
      this.opts.onError(err);
    }
  }
}

import type { RuntimeRef } from "@bazhen/core";
import type { ExitStatus } from "@bazhen/protocol";

export interface DeadTerminal {
  readonly ref: RuntimeRef;
  readonly status: ExitStatus;
}

type Listener = (ref: RuntimeRef, status: ExitStatus) => void;

/**
 * Polls for dead terminals while anyone listens, and reports every one on every tick. tmux could
 * announce a death only through a `pane-died` hook running a shell command back into Bazhen,
 * which the argv-only rule forbids (foundation-design §8.2).
 */
export class ExitWatch {
  private readonly read: () => Promise<readonly DeadTerminal[]>;
  private readonly intervalMs: number;
  private readonly listeners = new Set<Listener>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private reading = false;

  constructor(read: () => Promise<readonly DeadTerminal[]>, intervalMs: number) {
    this.read = read;
    this.intervalMs = intervalMs;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    this.timer ??= setInterval(() => void this.tick(), this.intervalMs);
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
      for (const { ref, status } of await this.read())
        for (const listener of this.listeners) listener(ref, status);
    } finally {
      this.reading = false;
    }
  }
}

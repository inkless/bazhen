import type { StreamFailure } from "@bazhen/core";
import { Settle } from "./settle.ts";

export interface ScreenWatchOptions {
  /** How long output must pause, or at most how long it may run, before the screen is re-read. */
  readonly quietMs: number;
  readonly maxWaitMs: number;
  /** Reads whether the program is on its alternate screen now. */
  readonly check: () => Promise<boolean>;
  /** Where the program was when the watch began. */
  readonly alternate: boolean;
}

/**
 * Turns tmux's alternate-screen flag, which can only be asked for, into pushed changes. One check
 * at a time: a busy terminal settles every half second whether or not it changed. A check asked
 * for while one runs is run after it, since the screen may have switched since.
 */
export class ScreenWatch {
  private readonly check: () => Promise<boolean>;
  private readonly settle: Settle;
  private readonly changed: ((alternate: boolean) => void)[] = [];
  private readonly failed: ((failure: StreamFailure) => void)[] = [];
  private alternate: boolean;
  private checking = false;
  /** Output arrived while a check was running, so its answer may already be stale. */
  private stale = false;
  /** Whether the last check failed, so a failing one is reported once, not every time. */
  private failing = false;
  private disposed = false;

  constructor(opts: ScreenWatchOptions) {
    this.check = opts.check;
    this.alternate = opts.alternate;
    this.settle = new Settle(opts.quietMs, opts.maxWaitMs, () => this.run());
  }

  /** Output arrived. */
  poke(): void {
    this.settle.poke();
  }

  onAlternate(cb: (alternate: boolean) => void): void {
    this.changed.push(cb);
  }

  onFailure(cb: (failure: StreamFailure) => void): void {
    this.failed.push(cb);
  }

  dispose(): void {
    this.disposed = true;
    this.settle.dispose();
  }

  private run(): void {
    if (this.checking) {
      this.stale = true;
      return;
    }
    this.checking = true;
    this.stale = false;
    this.check()
      .then(
        (alternate) => {
          this.failing = false;
          if (alternate === this.alternate || this.disposed) return;
          this.alternate = alternate;
          for (const cb of this.changed) cb(alternate);
        },
        (err: unknown) => {
          if (this.failing || this.disposed) return;
          this.failing = true;
          for (const cb of this.failed) cb({ what: "screen check", cause: err });
        },
      )
      .finally(() => {
        this.checking = false;
        if (this.stale && !this.disposed) this.run();
      });
  }
}

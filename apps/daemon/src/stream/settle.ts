/**
 * Runs `fire` once activity has been quiet for `quietMs`, and at least every `maxWaitMs` while it
 * never goes quiet, so a terminal that prints continuously still gets checked. A poke only notes
 * the time: it comes with every chunk of output, so it must not touch the timers.
 */
export class Settle {
  private quiet: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;
  private last = 0;
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly fire: () => void;

  constructor(quietMs: number, maxWaitMs: number, fire: () => void) {
    this.quietMs = quietMs;
    this.maxWaitMs = maxWaitMs;
    this.fire = fire;
  }

  poke(): void {
    this.last = performance.now();
    this.quiet ??= setTimeout(() => this.whenQuiet(), this.quietMs);
    this.deadline ??= setTimeout(() => this.run(), this.maxWaitMs);
  }

  dispose(): void {
    clearTimeout(this.quiet);
    clearTimeout(this.deadline);
    this.quiet = this.deadline = undefined;
  }

  private whenQuiet(): void {
    const idle = performance.now() - this.last;
    if (idle >= this.quietMs) this.run();
    else this.quiet = setTimeout(() => this.whenQuiet(), this.quietMs - idle);
  }

  private run(): void {
    this.dispose();
    this.fire();
  }
}

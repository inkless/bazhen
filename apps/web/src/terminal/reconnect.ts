const FIRST_MS = 250;
const LONGEST_MS = 5000;

/** How long to wait before each attempt to reattach: doubling, then steady at five seconds. */
export class Backoff {
  private attempts = 0;

  next(): number {
    return Math.min(FIRST_MS * 2 ** this.attempts++, LONGEST_MS);
  }

  /** A view that got its snapshot is attached again; its next loss starts over. */
  reset(): void {
    this.attempts = 0;
  }
}

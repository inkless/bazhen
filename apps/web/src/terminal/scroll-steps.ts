/**
 * Turns travel in pixels (a finger's, or a trackpad's many small wheel events) into whole scroll
 * steps, one per text row. Positive travel reveals earlier output, like a wheel turned up.
 */
export class ScrollSteps {
  private travel = 0;

  /** Adds `pixels` of travel and returns the whole steps it completes, signed. */
  add(pixels: number, rowHeight: number): number {
    this.travel += pixels;
    const steps = Math.trunc(this.travel / rowHeight);
    this.travel -= steps * rowHeight;
    return steps;
  }

  reset(): void {
    this.travel = 0;
  }
}

// A swipe's momentum, as a phone's own scrolling has: lifted mid-flick, the content goes on
// moving and slows to a stop; lifted after a pause, it stays where the finger left it. Times are
// in milliseconds and travel in pixels, from whatever clock the caller reads; tuning is below.

/** How fast velocity falls: to 1/e of itself each this many ms. A fling travels its speed × this. */
export const FLING_TIME_CONSTANT_MS = 325;
/** The slowest release, in px/ms, that flings at all; a slower one is a drag that stops. */
export const FLING_MIN_VELOCITY = 0.3;
/** Below this speed, in px/ms, a fling has stopped. */
export const FLING_STOP_VELOCITY = 0.02;
/** How much of the finger's last movement the release speed is measured over, in ms. */
export const VELOCITY_WINDOW_MS = 100;

/** Where the finger was, and when, over its last moments on the screen. */
export class Fling {
  private samples: { t: number; y: number }[] = [];

  /** The finger is at `y` at time `t`. */
  track(t: number, y: number): void {
    this.samples.push({ t, y });
    this.samples = this.samples.filter((s) => s.t >= t - VELOCITY_WINDOW_MS);
  }

  reset(): void {
    this.samples = [];
  }

  /** The finger lifts at `t`: the glide that follows, or null when it was moving too slowly. */
  release(t: number): Glide | null {
    const recent = this.samples.filter((s) => s.t >= t - VELOCITY_WINDOW_MS);
    this.samples = [];
    const first = recent[0];
    const last = recent.at(-1);
    if (first === undefined || last === undefined || last.t <= first.t) return null;
    const velocity = (last.y - first.y) / (last.t - first.t);
    return Math.abs(velocity) < FLING_MIN_VELOCITY ? null : new Glide(velocity, t);
  }
}

/** The travel after a release at `velocity` px/ms, slowing as it goes. */
export class Glide {
  private readonly velocity: number;
  private readonly start: number;
  private travelled = 0;

  constructor(velocity: number, start: number) {
    this.velocity = velocity;
    this.start = start;
  }

  /** The travel since the previous call, at time `t`, and whether the glide has stopped. */
  advance(t: number): { pixels: number; done: boolean } {
    const elapsed = Math.max(0, t - this.start);
    const decay = Math.exp(-elapsed / FLING_TIME_CONSTANT_MS);
    const position = this.velocity * FLING_TIME_CONSTANT_MS * (1 - decay);
    const pixels = position - this.travelled;
    this.travelled = position;
    return { pixels, done: Math.abs(this.velocity * decay) < FLING_STOP_VELOCITY };
  }
}

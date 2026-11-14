import { describe, expect, it } from "vitest";
import { Fling, FLING_TIME_CONSTANT_MS, VELOCITY_WINDOW_MS } from "./fling.ts";

/** A finger moving `perMs` px each ms from `y`, sampled every 10 ms from time 0 to `until`. */
function moved(perMs: number, until: number): Fling {
  const fling = new Fling();
  for (let t = 0; t <= until; t += 10) fling.track(t, perMs * t);
  return fling;
}

/** Everything a glide travels, frame by frame at 60 Hz, until it stops. */
function glide(fling: Fling, at: number): { pixels: number; frames: number } {
  const g = fling.release(at);
  let pixels = 0;
  let frames = 0;
  // Bounded, so a glide that never stops fails an assertion rather than hanging the run.
  for (let t = at, done = g === null; !done && frames < 1000; t += 16) {
    const step = g?.advance(t) ?? { pixels: 0, done: true };
    pixels += step.pixels;
    frames++;
    done = step.done;
  }
  return { pixels, frames };
}

describe("a swipe's momentum", () => {
  it("glides on after a quick release, about its speed times the time constant", () => {
    const { pixels } = glide(moved(2, 200), 200);
    expect(pixels).toBeGreaterThan(2 * FLING_TIME_CONSTANT_MS * 0.95);
    expect(pixels).toBeLessThanOrEqual(2 * FLING_TIME_CONSTANT_MS);
  });

  it("glides the way the finger was going", () => {
    expect(glide(moved(-2, 200), 200).pixels).toBeLessThan(0);
  });

  it("slows as it goes, and stops", () => {
    const g = moved(2, 200).release(200);
    const early = g?.advance(216).pixels;
    g?.advance(1200);
    const late = g?.advance(1216).pixels;
    expect([Number(early) > Number(late), glide(moved(2, 200), 200).frames < 200]).toEqual([
      true,
      true,
    ]);
  });

  it("doesn't glide after a slow drag", () => {
    expect(moved(0.1, 200).release(200)).toBeNull();
  });

  it("doesn't glide when the finger paused before it lifted", () => {
    expect(moved(2, 200).release(200 + VELOCITY_WINDOW_MS + 1)).toBeNull();
  });

  it("doesn't glide from a touch that never moved", () => {
    const fling = new Fling();
    fling.track(0, 50);
    expect(fling.release(5)).toBeNull();
  });
});

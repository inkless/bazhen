import { describe, expect, it } from "vitest";
import {
  Fling,
  FLING_TIME_CONSTANT_MS,
  Glide,
  RELEASE_PAUSE_MS,
  VELOCITY_WINDOW_MS,
} from "./fling.ts";

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
    g?.advance(200);
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

  it("doesn't glide when the finger stopped before it lifted", () => {
    expect(moved(2, 200).release(200 + RELEASE_PAUSE_MS + 10)).toBeNull();
  });

  // Touches as a phone reports them: a sample a frame, the lift a little after the last.
  it.each([
    ["a 60 Hz cadence", 16, 0],
    ["a 120 Hz cadence", 8, 0],
    ["a lift 25 ms after the last move", 16, 25],
    ["a lift 50 ms after the last move", 16, 50],
  ])("glides at the finger's speed for %s", (_what, every, gap) => {
    const fling = new Fling();
    for (let t = 0; t <= 160; t += every) fling.track(t, 1.5 * t);
    const last = 160 - (160 % every);
    const g = fling.release(last + gap);
    g?.advance(0);
    // The first 16 ms of travel, at about the finger's 1.5 px/ms.
    expect(Number(g?.advance(16).pixels) / 16).toBeCloseTo(1.5, 0);
  });

  it("glides at the speed the finger had slowed to, not its fastest", () => {
    const fling = new Fling();
    let y = 0;
    for (let t = 0; t <= 300; t += 16) {
      y += Math.max(0.6, 3 - t / 100) * 16;
      fling.track(t, y);
    }
    const g = fling.release(304);
    g?.advance(0);
    // It ended at 0.6 px/ms; the first 16 ms of the glide go about that fast.
    expect(Number(g?.advance(16).pixels) / 16).toBeCloseTo(0.6, 1);
  });

  it("doesn't glide from a lift timed before the finger's last move", () => {
    expect(moved(2, 200).release(150)).toBeNull();
  });

  it("starts its clock at its first frame, whatever clock the touch was timed on", () => {
    const g = moved(2, 200).release(200);
    const first = g?.advance(5_000_000);
    const next = g?.advance(5_000_016);
    expect([first?.pixels, Number(next?.pixels) > 0, next?.done]).toEqual([0, true, false]);
  });

  it("ends after ten time constants, however fast it started", () => {
    const g = new Glide(1e6);
    g.advance(0);
    expect(g.advance(10 * FLING_TIME_CONSTANT_MS + 1).done).toBe(true);
  });

  it("doesn't glide from a touch that never moved", () => {
    const fling = new Fling();
    fling.track(0, 50);
    expect(fling.release(5)).toBeNull();
  });
});

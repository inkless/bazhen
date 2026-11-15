import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followViewport, SETTLE_MS, type AppViewport } from "./viewport.ts";

/** A visual viewport the test moves, over a window `innerHeight` tall. */
function fakeWindow(innerHeight: number) {
  const target = new EventTarget();
  const viewport = {
    height: innerHeight,
    offsetTop: 0,
    scale: 1,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  const move = (change: Partial<typeof viewport>, event = "resize") => {
    Object.assign(viewport, change);
    target.dispatchEvent(new Event(event));
  };
  return { window: { innerHeight, visualViewport: viewport }, move };
}

function follow(innerHeight: number) {
  const fake = fakeWindow(innerHeight);
  const applied: AppViewport[] = [];
  const stop = followViewport(fake.window, (v) => applied.push(v));
  return { ...fake, applied, stop };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the app's viewport", () => {
  it("is the window's at once, before anything moves", () => {
    expect(follow(800).applied).toEqual([{ top: 0, height: 800, keyboard: false }]);
  });

  it("takes a soft keyboard's animation as one change, to where it ends", () => {
    const { move, applied } = follow(800);
    for (let height = 790; height >= 450; height -= 10) {
      move({ height });
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied.slice(1)).toEqual([{ top: 0, height: 450, keyboard: true }]);
  });

  it("takes the keyboard going away as one change too", () => {
    const { move, applied } = follow(800);
    move({ height: 450 });
    vi.advanceTimersByTime(SETTLE_MS);
    for (let height = 460; height <= 800; height += 10) {
      move({ height });
      vi.advanceTimersByTime(16);
    }
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied.slice(2)).toEqual([{ top: 0, height: 800, keyboard: false }]);
  });

  it("follows the visible part where the browser pans it, as iOS does to a focused field", () => {
    const { move, applied } = follow(800);
    move({ height: 450 });
    move({ offsetTop: 120 }, "scroll");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied.slice(1)).toEqual([{ top: 120, height: 450, keyboard: true }]);
  });

  it("is not a keyboard when a toolbar folds away", () => {
    const { move, applied } = follow(800);
    move({ height: 750 });
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied.at(-1)).toEqual({ top: 0, height: 750, keyboard: false });
  });

  it("stays as it was while the user pinches to zoom", () => {
    const { move, applied } = follow(800);
    move({ height: 400, scale: 2 });
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied).toHaveLength(1);
  });

  it("stops following when torn down, a pending change included", () => {
    const { move, applied, stop } = follow(800);
    move({ height: 450 });
    stop();
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied).toHaveLength(1);
  });

  it("never changes where there is no visual viewport", () => {
    const applied: AppViewport[] = [];
    followViewport({ innerHeight: 800, visualViewport: null }, (v) => applied.push(v));
    expect(applied).toEqual([]);
  });
});

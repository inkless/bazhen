import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followViewport, SETTLE_MS, type AppViewport } from "./viewport.ts";

/** A window and its visual viewport the test moves, and where focus is. */
function fakeWindow(innerWidth: number, innerHeight: number) {
  const target = new EventTarget();
  const viewportEvents = new EventTarget();
  const focusEvents = new EventTarget();
  const viewport = {
    height: innerHeight,
    offsetTop: 0,
    scale: 1,
    addEventListener: viewportEvents.addEventListener.bind(viewportEvents),
    removeEventListener: viewportEvents.removeEventListener.bind(viewportEvents),
  };
  const window = {
    innerWidth,
    innerHeight,
    visualViewport: viewport,
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  };
  let inTerminal = false;
  const move = (change: Partial<typeof viewport>, event = "resize") => {
    Object.assign(viewport, change);
    viewportEvents.dispatchEvent(new Event(event));
  };
  /** Focus moving into a terminal, or out of it. */
  const focusTerminal = (into: boolean) => {
    inTerminal = into;
    focusEvents.dispatchEvent(new Event(into ? "focusin" : "focusout"));
  };
  /** The window itself changing size, as a phone turning does. */
  const turn = (width: number, height: number) => {
    Object.assign(window, { innerWidth: width, innerHeight: height });
    Object.assign(viewport, { height });
    target.dispatchEvent(new Event("resize"));
  };
  const focus = { events: focusEvents, inTerminal: () => inTerminal };
  return { window, focus, move, focusTerminal, turn };
}

function follow(innerHeight: number, innerWidth = 400) {
  const fake = fakeWindow(innerWidth, innerHeight);
  const applied: AppViewport[] = [];
  const stop = followViewport(fake.window, fake.focus, (v) => applied.push(v));
  return { ...fake, applied, stop };
}

/** A keyboard animating from one covered height to another, a frame at a time. */
function animate(move: (change: { height: number }) => void, from: number, to: number) {
  const step = from < to ? 10 : -10;
  for (let height = from + step; step > 0 ? height <= to : height >= to; height += step) {
    move({ height });
    vi.advanceTimersByTime(16);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the app's viewport", () => {
  it("is the window's at once, before anything moves", () => {
    expect(follow(800).applied).toEqual([{ top: 0, height: 800, keyboard: false, typing: false }]);
  });

  it("takes a soft keyboard's animation as one change, to where it ends", () => {
    const { move, applied } = follow(800);
    animate(move, 800, 450);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied.slice(1)).toEqual([{ top: 0, height: 450, keyboard: true, typing: false }]);
  });

  it("takes a terminal's focus and the keyboard opening for it as one change", () => {
    const { move, focusTerminal, applied } = follow(800);
    focusTerminal(true);
    animate(move, 800, 450);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied.slice(1)).toEqual([{ top: 0, height: 450, keyboard: true, typing: true }]);
  });

  it("takes a terminal losing focus and the keyboard closing as one change", () => {
    const { move, focusTerminal, applied } = follow(800);
    focusTerminal(true);
    move({ height: 450 });
    vi.advanceTimersByTime(SETTLE_MS);
    focusTerminal(false);
    vi.advanceTimersByTime(50);
    animate(move, 450, 800);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied.slice(2)).toEqual([{ top: 0, height: 800, keyboard: false, typing: false }]);
  });

  it("follows focus moving into a terminal while the keyboard stays up", () => {
    const { move, focusTerminal, applied } = follow(800);
    move({ height: 450 });
    vi.advanceTimersByTime(SETTLE_MS);
    focusTerminal(true);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied.slice(2)).toEqual([{ top: 0, height: 450, keyboard: true, typing: true }]);
  });

  it("takes a turn of the phone at once, with no frame where the app is the old height", () => {
    const { turn, applied } = follow(844, 390);
    turn(844, 390);
    expect(applied.slice(1)).toEqual([{ top: 0, height: 390, keyboard: false, typing: false }]);
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied).toHaveLength(2);
  });

  it("follows the visible part where the browser pans it, as iOS does to a focused field", () => {
    const { move, applied } = follow(800);
    move({ height: 450 });
    move({ offsetTop: 120 }, "scroll");
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied.slice(1)).toEqual([{ top: 120, height: 450, keyboard: true, typing: false }]);
  });

  it("is not a keyboard when a toolbar folds away", () => {
    const { move, applied } = follow(800);
    move({ height: 750 });
    vi.advanceTimersByTime(SETTLE_MS);
    expect(applied.at(-1)).toEqual({ top: 0, height: 750, keyboard: false, typing: false });
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
    const { window, focus } = fakeWindow(400, 800);
    const applied: AppViewport[] = [];
    followViewport({ ...window, visualViewport: null }, focus, (v) => applied.push(v));
    expect(applied).toEqual([]);
  });
});

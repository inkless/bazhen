import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { attachTakeover } from "./takeover.ts";

/** An event target that counts what it holds, so a teardown that leaves a listener is seen. */
class Target extends EventTarget {
  private readonly held = new Map<string, number>();
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    this.held.set(args[0], (this.held.get(args[0]) ?? 0) + 1);
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
    this.held.set(args[0], (this.held.get(args[0]) ?? 0) - 1);
    super.removeEventListener(...args);
  }
  get listeners() {
    return [...this.held.values()].reduce((n, count) => n + count, 0);
  }
}

/** What a pointer lands on: `instanceof Element` is how the rule tells a node from the document. */
class FakeElement extends EventTarget {
  private readonly classes: readonly string[];
  constructor(classes: readonly string[] = []) {
    super();
    this.classes = classes;
  }
  closest(selector: string) {
    return this.classes.includes(selector.slice(1)) ? this : null;
  }
}

/**
 * The terminal host: its box is on the page at (100, 50), a 2px border inside it, and its
 * scrollbars take 15px of the right and bottom edge, as an `overflow: auto` box does.
 */
class FakeHost extends Target {
  clientLeft = 2;
  clientTop = 2;
  clientWidth = 383;
  clientHeight = 283;
  getBoundingClientRect() {
    const rect = {
      x: 100,
      y: 50,
      left: 100,
      top: 50,
      width: 400,
      height: 300,
      right: 500,
      bottom: 350,
    };
    return { ...rect, toJSON: () => rect };
  }
}

/** An event as the browser would deliver it, aimed at `target` when that isn't where it fired. */
function fire(on: EventTarget, type: string, props: object = {}, target?: EventTarget) {
  const event = Object.assign(new Event(type), props);
  if (target !== undefined) Object.defineProperties(event, { target: { value: target } });
  on.dispatchEvent(event);
}

const CONTENT = { x: 200, y: 150 };
// The content box ends at 100 + 2 + 383 = 485 across and 50 + 2 + 283 = 335 down.
const LAST_CONTENT = { x: 484, y: 334 };

let host: FakeHost;
let windowEvents: Target;
let activeElement: unknown;
let engaged: number;
let stop: () => void;

beforeEach(() => {
  host = new FakeHost();
  windowEvents = new Target();
  activeElement = null;
  engaged = 0;
  vi.stubGlobal("Element", FakeElement);
  vi.stubGlobal("window", windowEvents);
  vi.stubGlobal("document", {
    get activeElement() {
      return activeElement;
    },
  });
  stop = attachTakeover(host, () => engaged++);
});

afterEach(() => vi.unstubAllGlobals());

type Spot = { x: number; y: number };

/** A pointer event at `at` on the host, or on `on` inside it. */
function pointer(type: string, at: Spot, pointerType: string, on?: FakeElement) {
  fire(host, type, { clientX: at.x, clientY: at.y, pointerType }, on);
}

/** A finger down at one spot and up at another. */
function touch(down: Spot, up: Spot) {
  pointer("pointerdown", down, "touch");
  pointer("pointerup", up, "touch");
}

describe("a mouse press", () => {
  it("engages from inside the content, up to the last pixel before the gutters, past the border", () => {
    pointer("pointerdown", CONTENT, "mouse");
    pointer("pointerdown", LAST_CONTENT, "mouse");
    expect(engaged).toBe(2);
  });

  it("doesn't engage from the vertical scrollbar's gutter", () => {
    pointer("pointerdown", { x: 485, y: CONTENT.y }, "mouse");
    expect(engaged).toBe(0);
  });

  it("doesn't engage from the horizontal scrollbar's gutter", () => {
    pointer("pointerdown", { x: CONTENT.x, y: 335 }, "mouse");
    expect(engaged).toBe(0);
  });

  it("puts the gutters at the box's edge when it has no border", () => {
    host.clientLeft = 0;
    host.clientTop = 0;
    host.clientWidth = 385;
    host.clientHeight = 285;
    pointer("pointerdown", LAST_CONTENT, "mouse");
    expect(engaged).toBe(1);
    pointer("pointerdown", { x: 485, y: CONTENT.y }, "mouse");
    pointer("pointerdown", { x: CONTENT.x, y: 335 }, "mouse");
    expect(engaged).toBe(1);
  });

  it("doesn't engage from a drawn scrollbar, even inside the content box", () => {
    pointer("pointerdown", CONTENT, "mouse", new FakeElement(["scrollbar"]));
    expect(engaged).toBe(0);
  });

  it("engages from a pen as it does from a mouse", () => {
    pointer("pointerdown", CONTENT, "pen");
    expect(engaged).toBe(1);
  });
});

describe("a touch", () => {
  it("engages on a tap, when the finger lifts", () => {
    pointer("pointerdown", CONTENT, "touch");
    expect(engaged).toBe(0);
    pointer("pointerup", { x: CONTENT.x + 3, y: CONTENT.y + 4 }, "touch");
    expect(engaged).toBe(1);
  });

  it("doesn't engage on a swipe", () => {
    touch(CONTENT, { x: CONTENT.x, y: CONTENT.y - 10 });
    touch(CONTENT, { x: CONTENT.x + 60, y: CONTENT.y + 60 });
    expect(engaged).toBe(0);
  });

  it("engages on travel just under the slop, as a tap", () => {
    touch(CONTENT, { x: CONTENT.x, y: CONTENT.y + 9 });
    expect(engaged).toBe(1);
  });

  it("forgets a cancelled touch, so a stray lift doesn't engage", () => {
    pointer("pointerdown", CONTENT, "touch");
    fire(host, "pointercancel");
    pointer("pointerup", CONTENT, "touch");
    expect(engaged).toBe(0);
  });

  it("counts a tap once: a second lift without a press doesn't engage", () => {
    touch(CONTENT, CONTENT);
    pointer("pointerup", CONTENT, "touch");
    expect(engaged).toBe(1);
  });

  it("doesn't start from the scrollbar's gutter or a drawn scrollbar", () => {
    touch({ x: 485, y: CONTENT.y }, { x: 485, y: CONTENT.y });
    pointer("pointerdown", CONTENT, "touch", new FakeElement(["scrollbar"]));
    pointer("pointerup", CONTENT, "touch");
    expect(engaged).toBe(0);
  });

  it("isn't a tap when another pointer lifts, and leaves the touch waiting for its own lift", () => {
    pointer("pointerdown", CONTENT, "touch");
    pointer("pointerup", CONTENT, "mouse");
    expect(engaged).toBe(0);
    pointer("pointerup", CONTENT, "touch");
    expect(engaged).toBe(1);
  });
});

describe("focus", () => {
  it("engages when focus moves to something inside the host", () => {
    fire(host, "focusin", {}, new FakeElement());
    expect(engaged).toBe(1);
  });

  it("doesn't engage when focus lands on the host itself, which scrolling and its scrollbar do", () => {
    fire(host, "focusin");
    expect(engaged).toBe(0);
  });

  it("engages when the window gains focus", () => {
    activeElement = new FakeElement();
    fire(windowEvents, "focus");
    expect(engaged).toBe(1);
    activeElement = null;
    fire(windowEvents, "focus");
    expect(engaged).toBe(2);
  });

  it("doesn't engage when the window regains focus onto the host itself", () => {
    activeElement = host;
    fire(windowEvents, "focus");
    expect(engaged).toBe(0);
  });
});

describe("the teardown", () => {
  it("leaves no listener on the host or the window", () => {
    expect(host.listeners + windowEvents.listeners).toBeGreaterThan(0);
    stop();
    expect(host.listeners).toBe(0);
    expect(windowEvents.listeners).toBe(0);
  });

  it("engages from nothing afterwards, however the view is touched", () => {
    pointer("pointerdown", CONTENT, "touch");
    stop();
    pointer("pointerup", CONTENT, "touch");
    pointer("pointerdown", CONTENT, "mouse");
    fire(host, "focusin", {}, new FakeElement());
    fire(windowEvents, "focus");
    expect(engaged).toBe(0);
  });
});

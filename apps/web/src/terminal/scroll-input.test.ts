import { describe, expect, it } from "vitest";
import { bottomPin, GLIDE_STEPS_PER_FRAME, glideSteps } from "./scroll-input.ts";

describe("a glide's rows a frame", () => {
  it("holds a program fed arrow keys or mouse reports to a few a frame, either way", () => {
    expect([glideSteps(40, "arrows"), glideSteps(-40, "app"), glideSteps(2, "arrows")]).toEqual([
      GLIDE_STEPS_PER_FRAME,
      -GLIDE_STEPS_PER_FRAME,
      2,
    ]);
  });

  it("moves the page's own scrollback by all of them", () => {
    expect(glideSteps(40, "local")).toBe(40);
  });
});

/** A box showing 300px of what it holds, which keeps its scroll in range as a browser does. */
function box(initial: number) {
  let top = 0;
  let held = initial;
  let shown = 300;
  const clamp = (next: number) => Math.max(0, Math.min(next, held - shown));
  return {
    get clientHeight() {
      return shown;
    },
    set clientHeight(next: number) {
      shown = next;
      top = clamp(top);
    },
    get height() {
      return held;
    },
    set height(next: number) {
      held = next;
      top = clamp(top);
    },
    get scrollHeight() {
      return held;
    },
    get scrollTop() {
      return top;
    },
    set scrollTop(next: number) {
      top = clamp(next);
    },
  };
}

describe("a view's bottom pin", () => {
  it("keeps the view at the bottom through a second growth told before the pin's own scroll", () => {
    const view = box(400);
    const pin = bottomPin(view);
    pin.resized();
    view.height = 800;
    pin.scrolled();
    pin.resized();
    expect(view.scrollTop).toBe(500);
  });

  it("leaves a view the user moved up where it is, and follows again once they are back down", () => {
    const view = box(400);
    const pin = bottomPin(view);
    pin.resized();
    view.scrollTop = 40;
    pin.scrolled();
    view.height = 800;
    pin.resized();
    const left = view.scrollTop;
    view.scrollTop = 500;
    pin.scrolled();
    view.height = 900;
    pin.resized();
    expect([left, view.scrollTop]).toEqual([40, 600]);
  });

  it("keeps the view at the bottom when what it holds shrinks and grows before the clamp is told", () => {
    const view = box(340);
    const pin = bottomPin(view);
    pin.resized();
    view.height = 300;
    view.height = 660;
    pin.scrolled();
    pin.resized();
    expect(view.scrollTop).toBe(360);
  });

  it("keeps the view at the bottom when a scrollbar shortens it before its scroll is told", () => {
    const view = box(400);
    const pin = bottomPin(view);
    pin.resized();
    view.clientHeight = 280;
    pin.scrolled();
    pin.resized();
    expect(view.scrollTop).toBe(120);
  });
});

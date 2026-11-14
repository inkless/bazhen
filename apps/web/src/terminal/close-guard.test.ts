import { describe, expect, it } from "vitest";
import { guardClose } from "./close-guard.ts";

function page() {
  const window = new EventTarget();
  const document = new EventTarget();
  let focused = true;
  const stays: number[] = [];
  const stop = guardClose(
    { window, document },
    () => focused,
    () => stays.push(Date.now()),
  );
  return {
    window,
    document,
    stays,
    stop,
    blur: () => (focused = false),
    key: (type: "keydown" | "keyup", ctrlKey: boolean) =>
      window.dispatchEvent(Object.assign(new Event(type), { ctrlKey })),
    /** Whether a close now asks first. */
    asks: () => {
      const close = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(close);
      return close.defaultPrevented;
    },
  };
}

const turn = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("the close guard", () => {
  it("asks before closing while Ctrl is down in a focused terminal", () => {
    const p = page();
    p.key("keydown", true);
    expect(p.asks()).toBe(true);
  });

  it("never asks without Ctrl, so a reload or a close from the mouse goes through", () => {
    const p = page();
    p.key("keydown", false);
    expect(p.asks()).toBe(false);
  });

  it("never asks while focus is outside the terminal", () => {
    const p = page();
    p.blur();
    p.key("keydown", true);
    expect(p.asks()).toBe(false);
  });

  it("stops asking once Ctrl is released", () => {
    const p = page();
    p.key("keydown", true);
    p.key("keyup", false);
    expect(p.asks()).toBe(false);
  });

  it("stops asking when Ctrl is carried away to another window, as by Alt+Tab", () => {
    const p = page();
    p.key("keydown", true);
    p.window.dispatchEvent(new Event("blur"));
    expect(p.asks()).toBe(false);
  });

  it("stops asking when the page is hidden with Ctrl down", () => {
    const p = page();
    p.key("keydown", true);
    p.document.dispatchEvent(new Event("visibilitychange"));
    expect(p.asks()).toBe(false);
  });

  it("reports that the user stayed only once the prompt is over", async () => {
    const p = page();
    p.key("keydown", true);
    p.asks();
    expect(p.stays).toHaveLength(0);
    await turn();
    expect(p.stays).toHaveLength(1);
  });

  it("asks nothing once stopped, even if it was armed", () => {
    const p = page();
    p.key("keydown", true);
    p.stop();
    expect(p.asks()).toBe(false);
    p.key("keydown", true);
    expect(p.asks()).toBe(false);
  });
});

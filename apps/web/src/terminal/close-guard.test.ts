import { describe, expect, it } from "vitest";
import { guardClose } from "./close-guard.ts";

/** An EventTarget that counts its `beforeunload` listeners. */
class Window extends EventTarget {
  unloadListeners = 0;
  override addEventListener(...args: Parameters<EventTarget["addEventListener"]>) {
    if (args[0] === "beforeunload") this.unloadListeners++;
    super.addEventListener(...args);
  }
  override removeEventListener(...args: Parameters<EventTarget["removeEventListener"]>) {
    if (args[0] === "beforeunload") this.unloadListeners--;
    super.removeEventListener(...args);
  }
}

function page() {
  const window = new Window();
  let windowFocused = true;
  const document = Object.assign(new EventTarget(), { hasFocus: () => windowFocused });
  let focused = true;
  let stays = 0;
  const stop = guardClose(
    { window, document },
    () => focused,
    () => stays++,
  );
  const send = (type: string, ctrlKey: boolean) =>
    window.dispatchEvent(Object.assign(new Event(type), { ctrlKey }));
  return {
    window,
    document,
    stays: () => stays,
    stop,
    focus: (now: boolean) => (focused = now),
    focusWindow: (now: boolean) => (windowFocused = now),
    key: (type: "keydown" | "keyup", ctrlKey: boolean) => send(type, ctrlKey),
    pointer: (ctrlKey: boolean, type = "pointermove") => send(type, ctrlKey),
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

  it("keeps asking while Ctrl is held across other keys, as for Ctrl+A then Ctrl+W", () => {
    const p = page();
    p.key("keydown", true);
    p.key("keyup", true);
    p.pointer(true);
    expect(p.asks()).toBe(true);
  });

  it("never asks after a key pressed without Ctrl", () => {
    const p = page();
    p.key("keydown", false);
    expect(p.asks()).toBe(false);
  });

  it("never arms while focus is outside the terminal", () => {
    const p = page();
    p.focus(false);
    p.key("keydown", true);
    expect([p.window.unloadListeners, p.asks()]).toEqual([0, false]);
  });

  it("doesn't ask once focus has left the terminal with Ctrl still down", () => {
    const p = page();
    p.key("keydown", true);
    p.focus(false);
    expect(p.asks()).toBe(false);
  });

  it("stops asking once Ctrl is released", () => {
    const p = page();
    p.key("keydown", true);
    p.key("keyup", false);
    expect(p.asks()).toBe(false);
  });

  it("stops asking at the next key pressed without Ctrl, as after staying by keyboard", () => {
    const p = page();
    p.key("keydown", true);
    p.key("keydown", false);
    expect(p.asks()).toBe(false);
  });

  it("stops asking once the pointer moves without Ctrl, as after staying with the mouse", () => {
    const p = page();
    p.key("keydown", true);
    p.pointer(false);
    expect(p.asks()).toBe(false);
  });

  it("asks again once the pointer moves with Ctrl still down, as after staying with Ctrl held", () => {
    const p = page();
    p.key("keydown", true);
    p.window.dispatchEvent(new Event("blur"));
    p.pointer(true);
    expect(p.asks()).toBe(true);
  });

  it("never arms from the pointer while focus is outside the terminal", () => {
    const p = page();
    p.focus(false);
    p.pointer(true);
    expect(p.window.unloadListeners).toBe(0);
  });

  it("never arms from a Ctrl+drag in another app crossing the window, its terminal still active", () => {
    const p = page();
    p.focusWindow(false);
    p.pointer(true);
    expect([p.window.unloadListeners, p.asks()]).toEqual([0, false]);
  });

  it("stops asking at a click without Ctrl", () => {
    const p = page();
    p.key("keydown", true);
    p.pointer(false, "pointerdown");
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

  it("holds a beforeunload listener only while armed, so Firefox can cache the page", () => {
    const p = page();
    const held = [p.window.unloadListeners];
    p.key("keydown", true);
    held.push(p.window.unloadListeners);
    p.key("keyup", false);
    held.push(p.window.unloadListeners);
    p.key("keydown", true);
    p.stop();
    held.push(p.window.unloadListeners);
    expect(held).toEqual([0, 1, 0, 0]);
  });

  it("reports that the user stayed only once the prompt is over", async () => {
    const p = page();
    p.key("keydown", true);
    p.asks();
    expect(p.stays()).toBe(0);
    await turn();
    expect(p.stays()).toBe(1);
  });

  it("reports no stay for a view stopped before the prompt is over", async () => {
    const p = page();
    p.key("keydown", true);
    p.asks();
    p.stop();
    await turn();
    expect(p.stays()).toBe(0);
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

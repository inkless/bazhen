import type { Terminal } from "@xterm/xterm";
import type { WheelAction } from "./scroll.ts";
import { ScrollSteps } from "./touch.ts";

const encoder = new TextEncoder();
const ARROWS = {
  normal: { up: encoder.encode("\x1b[A"), down: encoder.encode("\x1b[B") },
  application: { up: encoder.encode("\x1bOA"), down: encoder.encode("\x1bOB") },
};

/**
 * Routes the wheel, a trackpad and phone swipes on `element` by `route()` (foundation-design
 * §5.9), sending arrow keys through `input`. Returns the teardown.
 */
export function attachScrollInput(
  element: HTMLElement,
  term: Terminal,
  route: () => WheelAction,
  input: (bytes: Uint8Array<ArrayBuffer>) => void,
): () => void {
  const arrow = (up: boolean) => {
    const keys = term.modes.applicationCursorKeysMode ? ARROWS.application : ARROWS.normal;
    return up ? keys.up : keys.down;
  };
  const rowHeight = () => element.clientHeight / term.rows;

  const wheelSteps = new ScrollSteps();
  // Caught before xterm.js sees it, which its own wheel hook can't: returning false there still
  // scrolls the scrollback, and over an agent's alternate screen that scrollback is stale.
  const wheel = (event: WheelEvent) => {
    const action = route();
    if (action === "app" || action === "local") return;
    event.preventDefault();
    event.stopPropagation();
    if (action === "swallow") return;
    const row = rowHeight();
    const pixels =
      event.deltaMode === WheelEvent.DOM_DELTA_PIXEL ? -event.deltaY : -event.deltaY * row;
    const steps = wheelSteps.add(pixels, row);
    for (let i = 0; i < Math.abs(steps); i++) input(arrow(steps > 0));
  };

  // xterm.js 6 does nothing on a swipe: finger travel becomes the same steps a wheel makes.
  const screen = element.querySelector<HTMLElement>(".xterm-screen") ?? element;
  const touchSteps = new ScrollSteps();
  let lastY: number | null = null;
  const touchStart = (e: TouchEvent) => {
    lastY = e.touches[0]?.clientY ?? null;
    touchSteps.reset();
  };
  const touchMove = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (lastY === null || touch === undefined) return;
    const row = rowHeight();
    const steps = touchSteps.add(touch.clientY - lastY, row);
    lastY = touch.clientY;
    e.preventDefault();
    const action = route();
    const up = steps > 0;
    for (let i = 0; i < Math.abs(steps); i++) {
      if (action === "local") term.scrollLines(up ? -1 : 1);
      else if (action === "arrows") input(arrow(up));
      else if (action === "app") {
        // xterm.js encodes a wheel event as the mouse report the program asked for.
        const { clientX, clientY } = touch;
        const deltaY = up ? -row : row;
        screen.dispatchEvent(
          new WheelEvent("wheel", { deltaY, clientX, clientY, bubbles: true, cancelable: true }),
        );
      }
    }
  };
  const touchEnd = () => (lastY = null);

  element.addEventListener("wheel", wheel, { capture: true, passive: false });
  screen.addEventListener("touchstart", touchStart, { passive: true });
  screen.addEventListener("touchmove", touchMove, { passive: false });
  screen.addEventListener("touchend", touchEnd, { passive: true });
  return () => {
    element.removeEventListener("wheel", wheel, { capture: true });
    screen.removeEventListener("touchstart", touchStart);
    screen.removeEventListener("touchmove", touchMove);
    screen.removeEventListener("touchend", touchEnd);
  };
}

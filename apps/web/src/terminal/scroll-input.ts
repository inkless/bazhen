import type { Terminal } from "@xterm/xterm";
import type { WheelAction } from "./scroll.ts";
import { Fling, type Glide } from "./fling.ts";
import { ScrollSteps } from "./scroll-steps.ts";

const encoder = new TextEncoder();
/** The most rows a glide moves in one frame for a program fed arrow keys or mouse reports. */
export const GLIDE_STEPS_PER_FRAME = 3;
/** The person asked their system for less motion: a swipe then stops where the finger lifts. */
const reducedMotion = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
/** Pixels per unit of a wheel event's delta, by its `deltaMode`: pixels, lines or pages. */
function pixelsPerUnit(mode: number, row: number, rows: number): number {
  if (mode === WheelEvent.DOM_DELTA_PAGE) return row * rows;
  return mode === WheelEvent.DOM_DELTA_LINE ? row : 1;
}
const ARROWS = {
  normal: { up: encoder.encode("\x1b[A"), down: encoder.encode("\x1b[B") },
  application: { up: encoder.encode("\x1bOA"), down: encoder.encode("\x1bOB") },
};

/** A view's scroll input, as attached. */
export interface ScrollInput {
  /** Stops a swipe's glide, for anything that isn't a scroll: a key, a reattach. */
  stopGlide(): void;
  /** Whether a released swipe is still gliding. */
  gliding(): boolean;
  detach(): void;
}

/**
 * The rows a glide moves this frame. A program fed arrow keys or mouse reports gets at most
 * GLIDE_STEPS_PER_FRAME, however fast the flick; the page's own scrollback takes them all.
 */
export function glideSteps(steps: number, action: WheelAction): number {
  if (action === "local") return steps;
  return Math.sign(steps) * Math.min(Math.abs(steps), GLIDE_STEPS_PER_FRAME);
}

/**
 * Routes the wheel, a trackpad and phone swipes on `element` by `route()` (foundation-design
 * §5.9), sending arrow keys through `input`.
 */
export function attachScrollInput(
  element: HTMLElement,
  term: Terminal,
  route: () => WheelAction,
  input: (bytes: Uint8Array<ArrayBuffer>) => void,
): ScrollInput {
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
    const pixels = -event.deltaY * pixelsPerUnit(event.deltaMode, row, term.rows);
    const steps = wheelSteps.add(pixels, row);
    for (let i = 0; i < Math.abs(steps); i++) input(arrow(steps > 0));
  };

  // xterm.js 6 does nothing on a swipe: finger travel becomes the same steps a wheel makes.
  const screen = element.querySelector<HTMLElement>(".xterm-screen") ?? element;
  const touchSteps = new ScrollSteps();
  const fling = new Fling();
  let lastY: number | null = null;
  let lastX = 0;
  let gliding: number | null = null;
  const stopGlide = () => {
    if (gliding !== null) cancelAnimationFrame(gliding);
    gliding = null;
  };

  /**
   * Moves `steps` rows by `action`, revealing earlier output when positive; false once the page's
   * scrollback has no further to go.
   */
  const scrollBy = (steps: number, action: WheelAction, clientY: number): boolean => {
    const up = steps > 0;
    const row = rowHeight();
    for (let i = 0; i < Math.abs(steps); i++) {
      if (action === "local") {
        const buffer = term.buffer.active;
        if (up ? buffer.viewportY === 0 : buffer.viewportY === buffer.baseY) return false;
        term.scrollLines(up ? -1 : 1);
      } else if (action === "arrows") input(arrow(up));
      else if (action === "app") {
        // xterm.js encodes a wheel event as the mouse report the program asked for.
        const deltaY = up ? -row : row;
        screen.dispatchEvent(
          new WheelEvent("wheel", {
            deltaY,
            clientX: lastX,
            clientY,
            bubbles: true,
            cancelable: true,
          }),
        );
      }
    }
    return true;
  };

  /**
   * Carries a released swipe on, a frame at a time, as the phone's own scrolling would, by the
   * route it was released on: a program that switches screens mid-glide ends it, rather than
   * getting keys or reports meant for the page's scrollback.
   */
  const glide = (motion: Glide, action: WheelAction, clientY: number) => {
    const frame = (now: number) => {
      const { pixels, done } = motion.advance(now);
      const steps = glideSteps(touchSteps.add(pixels, rowHeight()), action);
      const going = !done && route() === action && scrollBy(steps, action, clientY);
      gliding = going ? requestAnimationFrame(frame) : null;
    };
    gliding = requestAnimationFrame(frame);
  };

  /** A finger, or the touch, ends: forget the swipe, without a glide. */
  const forget = () => {
    lastY = null;
    fling.reset();
  };
  const touchStart = (e: TouchEvent) => {
    stopGlide();
    const touch = e.touches[0];
    // A second finger makes it a pinch or the like, not a swipe.
    if (e.touches.length !== 1 || touch === undefined) return forget();
    lastY = touch.clientY;
    lastX = touch.clientX;
    touchSteps.reset();
    fling.reset();
    fling.track(e.timeStamp, touch.clientY);
  };
  const touchMove = (e: TouchEvent) => {
    const touch = e.touches[0];
    if (lastY === null || touch === undefined || e.touches.length !== 1) return;
    const steps = touchSteps.add(touch.clientY - lastY, rowHeight());
    lastY = touch.clientY;
    lastX = touch.clientX;
    fling.track(e.timeStamp, touch.clientY);
    e.preventDefault();
    scrollBy(steps, route(), touch.clientY);
  };
  const touchEnd = (e: TouchEvent) => {
    const releasedAt = lastY;
    // Only the last finger off releases a swipe.
    if (e.touches.length !== 0) return forget();
    const motion = fling.release(e.timeStamp);
    forget();
    if (motion === null || releasedAt === null || reducedMotion()) return;
    glide(motion, route(), releasedAt);
  };
  const touchCancel = () => {
    stopGlide();
    forget();
  };
  // Anything the person does next stops a glide; the glide's own mouse reports are not theirs.
  const interrupt = (e: Event) => {
    if (e.isTrusted) stopGlide();
  };

  element.addEventListener("wheel", wheel, { capture: true, passive: false });
  screen.addEventListener("touchstart", touchStart, { passive: true });
  screen.addEventListener("touchmove", touchMove, { passive: false });
  screen.addEventListener("touchend", touchEnd, { passive: true });
  screen.addEventListener("touchcancel", touchCancel, { passive: true });
  element.addEventListener("wheel", interrupt, { capture: true, passive: true });
  element.addEventListener("keydown", interrupt, { capture: true });
  return {
    stopGlide,
    gliding: () => gliding !== null,
    detach: () => {
      stopGlide();
      element.removeEventListener("wheel", interrupt, { capture: true });
      element.removeEventListener("keydown", interrupt, { capture: true });
      element.removeEventListener("wheel", wheel, { capture: true });
      screen.removeEventListener("touchstart", touchStart);
      screen.removeEventListener("touchmove", touchMove);
      screen.removeEventListener("touchend", touchEnd);
      screen.removeEventListener("touchcancel", touchCancel);
    },
  };
}

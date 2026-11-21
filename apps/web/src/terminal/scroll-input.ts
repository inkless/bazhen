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

/** A box that scrolls: how far down it is, how tall what it holds is, and how much of it shows. */
export interface ScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

/**
 * Keeps `box` at the bottom of what it holds as either changes size, until the user moves it away;
 * back at the bottom, it is kept there again. A scroll event is told a frame late, so it may find a
 * layout the resize observer hasn't reported yet: what it holds grew since the pin's own scroll, or
 * shrank and the browser clamped the box. Only an event that finds the sizes last reported says
 * where the user is; any other leaves the pin to the report that follows. So a user's scroll in
 * the frame of a resize is ignored: scrolling up, they are taken back to the bottom once; scrolling
 * back down, the view doesn't follow until they scroll again. A shrink and regrow to the reported
 * sizes within one frame can still read a clamp as the user's, and unpin.
 */
export function bottomPin(box: ScrollBox) {
  let pinned = true;
  let reported: readonly [number, number] | undefined;
  const moved = () => {
    pinned = box.scrollTop + box.clientHeight >= box.scrollHeight - 1;
  };
  return {
    /** The box, or what it holds, changed size. */
    resized: () => {
      reported = [box.scrollHeight, box.clientHeight];
      if (pinned) box.scrollTop = box.scrollHeight;
    },
    /** The box told of a scroll, by the user, the pin, or the browser keeping it in range. */
    scrolled: () => {
      if (reported?.[0] === box.scrollHeight && reported[1] === box.clientHeight) moved();
    },
    /** The user moved the box. */
    moved,
  };
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
  clipped: () => boolean,
): ScrollInput {
  const arrow = (up: boolean) => {
    const keys = term.modes.applicationCursorKeysMode ? ARROWS.application : ARROWS.normal;
    return up ? keys.up : keys.down;
  };
  const screen = element.querySelector<HTMLElement>(".xterm-screen") ?? element;
  const rowHeight = () => Math.max(1, screen.getBoundingClientRect().height / term.rows);
  const pin = bottomPin(element);
  const follow = new ResizeObserver(() => pin.resized());
  follow.observe(screen);
  follow.observe(element);
  const scrolled = () => pin.scrolled();
  element.addEventListener("scroll", scrolled);

  // The outer viewport shows part of one grid. At its edge the remaining travel
  // scrolls xterm's history. On the way back, show the live grid before panning down it.
  const pan = (dx: number, dy: number) => {
    if (!clipped()) return dy;
    element.scrollLeft += dx;
    const buffer = term.buffer.active;
    const history = (buffer.baseY - buffer.viewportY) * rowHeight();
    if (dy > 0 && history > 0) {
      if (dy < history) return dy;
      term.scrollToBottom();
      dy -= history;
    }
    const before = element.scrollTop;
    element.scrollTop += dy;
    pin.moved();
    return dy - (element.scrollTop - before);
  };

  const wheelSteps = new ScrollSteps();
  // Caught before xterm.js sees it, which its own wheel hook can't: returning false there still
  // scrolls the scrollback, which under tmux's alternate screen isn't the program's. On a real
  // alternate buffer, xterm.js would send arrow keys as typed input, taking the lease.
  const wheel = (event: WheelEvent) => {
    if (clipped()) {
      if (event.ctrlKey) {
        event.stopPropagation();
        return;
      }
      const row = rowHeight();
      const unit = pixelsPerUnit(event.deltaMode, row, element.clientHeight / row);
      const remaining = pan(event.deltaX * unit, event.deltaY * unit);
      term.scrollLines(-wheelSteps.add(-remaining, row));
      event.preventDefault();
      event.stopPropagation();
      return;
    }
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
    stopGlide();
    /** The page's scrollback has no further to go the way the glide is going. */
    const atEdge = () => {
      const buffer = term.buffer.active;
      return motion.revealsEarlier ? buffer.viewportY === 0 : buffer.viewportY === buffer.baseY;
    };
    const frame = (now: number) => {
      // Every frame, not only one that moves a row: a glide at the edge with speed to spare ends.
      if (
        action === "local" &&
        atEdge() &&
        !(clipped() && element.scrollHeight > element.clientHeight)
      ) {
        gliding = null;
        return;
      }
      const { pixels, done } = motion.advance(now);
      const steps = glideSteps(touchSteps.add(-pan(0, -pixels), rowHeight()), action);
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
    const remaining = pan(lastX - touch.clientX, lastY - touch.clientY);
    const steps = touchSteps.add(-remaining, rowHeight());
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
      follow.disconnect();
      element.removeEventListener("scroll", scrolled);
      element.removeEventListener("wheel", wheel, { capture: true });
      screen.removeEventListener("touchstart", touchStart);
      screen.removeEventListener("touchmove", touchMove);
      screen.removeEventListener("touchend", touchEnd);
      screen.removeEventListener("touchcancel", touchCancel);
    },
  };
}

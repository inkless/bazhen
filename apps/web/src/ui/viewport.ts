/** The part of the window the user sees, which the app is drawn in. */
export interface AppViewport {
  readonly top: number;
  readonly height: number;
  /** Whether the soft keyboard covers the bottom of the window. */
  readonly keyboard: boolean;
  /** Whether it covers it for a terminal being typed into, which then gets the whole app. */
  readonly typing: boolean;
}

/** What the page reads of `window.visualViewport`. */
export type VisualViewportLike = Pick<
  VisualViewport,
  "height" | "offsetTop" | "scale" | "addEventListener" | "removeEventListener"
>;

type Listening = Pick<EventTarget, "addEventListener" | "removeEventListener">;

/** What the page reads of `window`. */
export interface ViewportWindow extends Listening {
  readonly innerWidth: number;
  readonly innerHeight: number;
  readonly visualViewport: VisualViewportLike | null;
}

/** How much of the window must be covered to be the soft keyboard, not a toolbar. */
const KEYBOARD_PX = 100;

/**
 * How long the visual viewport must hold still before the app takes its size. A soft keyboard
 * animates in and out, and Android reports each frame: each would refit every terminal and resize
 * its program, where once is enough.
 */
export const SETTLE_MS = 150;

/** The app's viewport for what `viewport` shows; `null` while zoomed, when a resize is a pinch. */
export function appViewport(
  innerHeight: number,
  viewport: VisualViewportLike,
  inTerminal: boolean,
): AppViewport | null {
  if (viewport.scale !== 1) return null;
  const keyboard = innerHeight - viewport.height >= KEYBOARD_PX;
  return {
    top: viewport.offsetTop,
    height: viewport.height,
    keyboard,
    typing: keyboard && inTerminal,
  };
}

/**
 * How long a terminal that lost focus with the keyboard up still counts as typed into. iOS can
 * report the keyboard going only after its dismiss animation, longer after the blur than the
 * viewport takes to settle; the chrome must not come back before the height does.
 */
export const TYPING_HELD_MS = 600;

/**
 * Calls `apply` with the app's viewport now, then with each new one: at once when the window gets
 * wider or narrower, as when a phone turns, and otherwise once the visual viewport and focus settle,
 * the last of a run of changes. A window only changing height, a desktop's being dragged, settles
 * too. Focus moving in or out of a terminal is read with the viewport it settles with, and a
 * terminal that loses focus with the keyboard up stays typed into until the keyboard goes or
 * `TYPING_HELD_MS` passes, so the keyboard closing is one change, not the app's chrome coming back
 * first and its height after. Returns the teardown.
 */
export function followViewport(
  window: ViewportWindow,
  focus: { readonly events: Listening; readonly inTerminal: () => boolean },
  apply: (viewport: AppViewport) => void,
): () => void {
  const viewport = window.visualViewport;
  if (viewport === null) return () => {};
  let last: AppViewport | null = null;
  let heldUntil = 0;
  const read = () => {
    const held = last?.typing === true && Date.now() < heldUntil;
    const now = appViewport(window.innerHeight, viewport, focus.inTerminal() || held);
    if (now === null || same(now, last)) return;
    last = now;
    apply(now);
  };
  let width = window.innerWidth;
  let settling: ReturnType<typeof setTimeout> | undefined;
  let releasing: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(settling);
    if (window.innerWidth !== width) {
      width = window.innerWidth;
      read();
      return;
    }
    settling = setTimeout(read, SETTLE_MS);
  };
  const left = () => {
    if (last?.typing === true && !focus.inTerminal()) {
      heldUntil = Date.now() + TYPING_HELD_MS;
      clearTimeout(releasing);
      releasing = setTimeout(read, TYPING_HELD_MS);
    }
    changed();
  };
  read();
  const sources: [Listening, string, () => void][] = [
    [viewport, "resize", changed],
    [viewport, "scroll", changed],
    [window, "resize", changed],
    [focus.events, "focusin", changed],
    [focus.events, "focusout", left],
  ];
  for (const [source, type, listener] of sources) source.addEventListener(type, listener);
  return () => {
    clearTimeout(settling);
    clearTimeout(releasing);
    for (const [source, type, listener] of sources) source.removeEventListener(type, listener);
  };
}

const same = (a: AppViewport, b: AppViewport | null) =>
  b !== null &&
  a.top === b.top &&
  a.height === b.height &&
  a.keyboard === b.keyboard &&
  a.typing === b.typing;

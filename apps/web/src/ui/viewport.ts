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
 * Calls `apply` with the app's viewport now, then with each new one: at once when the window
 * itself changes size, as a rotation does, and otherwise once the visual viewport and focus
 * settle, the last of a run of changes. Focus moving in or out of a terminal is read with the
 * viewport it settles with, so the keyboard closing as a terminal loses focus is one change, not
 * the app's chrome coming back first and its height after. Returns the teardown.
 */
export function followViewport(
  window: ViewportWindow,
  focus: { readonly events: Listening; readonly inTerminal: () => boolean },
  apply: (viewport: AppViewport) => void,
): () => void {
  const viewport = window.visualViewport;
  if (viewport === null) return () => {};
  let last: AppViewport | null = null;
  const read = () => {
    const now = appViewport(window.innerHeight, viewport, focus.inTerminal());
    if (now === null || same(now, last)) return;
    last = now;
    apply(now);
  };
  const sizeOf = () => `${window.innerWidth}x${window.innerHeight}`;
  let size = sizeOf();
  let settling: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(settling);
    if (sizeOf() !== size) {
      size = sizeOf();
      read();
      return;
    }
    settling = setTimeout(read, SETTLE_MS);
  };
  read();
  const sources: [Listening, string][] = [
    [viewport, "resize"],
    [viewport, "scroll"],
    [window, "resize"],
    [focus.events, "focusin"],
    [focus.events, "focusout"],
  ];
  for (const [source, type] of sources) source.addEventListener(type, changed);
  return () => {
    clearTimeout(settling);
    for (const [source, type] of sources) source.removeEventListener(type, changed);
  };
}

const same = (a: AppViewport, b: AppViewport | null) =>
  b !== null &&
  a.top === b.top &&
  a.height === b.height &&
  a.keyboard === b.keyboard &&
  a.typing === b.typing;

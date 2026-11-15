/** The part of the window the user sees, which the app is drawn in. */
export interface AppViewport {
  readonly top: number;
  readonly height: number;
  /** Whether the soft keyboard covers the bottom of the window. */
  readonly keyboard: boolean;
}

/** What the page reads of `window.visualViewport`. */
export type VisualViewportLike = Pick<
  VisualViewport,
  "height" | "offsetTop" | "scale" | "addEventListener" | "removeEventListener"
>;

/** How much of the window must be covered to be the soft keyboard, not a toolbar. */
const KEYBOARD_PX = 100;

/**
 * How long the viewport must hold still before the app takes its size. A soft keyboard animates
 * in and out, and Android reports each frame: each would refit every terminal and resize its
 * program, where once is enough.
 */
export const SETTLE_MS = 150;

/** The app's viewport for what `viewport` shows; `null` while zoomed, when a resize is a pinch. */
export function appViewport(innerHeight: number, viewport: VisualViewportLike): AppViewport | null {
  if (viewport.scale !== 1) return null;
  return {
    top: viewport.offsetTop,
    height: viewport.height,
    keyboard: innerHeight - viewport.height >= KEYBOARD_PX,
  };
}

/**
 * Calls `apply` with the app's viewport now, then with each new one once the viewport settles,
 * the last of a run of changes. Returns the teardown.
 */
export function followViewport(
  window: { readonly innerHeight: number; readonly visualViewport: VisualViewportLike | null },
  apply: (viewport: AppViewport) => void,
): () => void {
  const viewport = window.visualViewport;
  if (viewport === null) return () => {};
  let last: AppViewport | null = null;
  const read = () => {
    const now = appViewport(window.innerHeight, viewport);
    if (now === null || same(now, last)) return;
    last = now;
    apply(now);
  };
  let settling: ReturnType<typeof setTimeout> | undefined;
  const changed = () => {
    clearTimeout(settling);
    settling = setTimeout(read, SETTLE_MS);
  };
  read();
  viewport.addEventListener("resize", changed);
  viewport.addEventListener("scroll", changed);
  return () => {
    clearTimeout(settling);
    viewport.removeEventListener("resize", changed);
    viewport.removeEventListener("scroll", changed);
  };
}

const same = (a: AppViewport, b: AppViewport | null) =>
  b !== null && a.top === b.top && a.height === b.height && a.keyboard === b.keyboard;

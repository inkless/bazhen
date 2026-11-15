/** What a drag's decision reads of one element on its way up from the touch. */
export interface ScrollBox {
  readonly overflowX: string;
  readonly overflowY: string;
  readonly scrollWidth: number;
  readonly clientWidth: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

const SCROLLS = new Set(["auto", "scroll"]);

/** Whether any of `boxes` can scroll along `axis`, so a drag that way has somewhere to go. */
export function scrollsAlong(boxes: readonly ScrollBox[], axis: "x" | "y"): boolean {
  return boxes.some((box) =>
    axis === "x"
      ? SCROLLS.has(box.overflowX) && box.scrollWidth > box.clientWidth
      : SCROLLS.has(box.overflowY) && box.scrollHeight > box.clientHeight,
  );
}

/**
 * Keeps a one-finger drag inside `root` from moving the page. With the soft keyboard up, iOS
 * pans the whole page under a drag that nothing in it can scroll, the key bar or a pane's header
 * say, which slides the app off the visible part of the window. A drag over something that
 * scrolls that way, or over a text field, where it moves the caret, is left alone, and so is a
 * pinch. Returns the teardown.
 */
export function guardPan(root: HTMLElement): () => void {
  let start: { x: number; y: number } | null = null;
  const touchStart = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    start = touch === undefined ? null : { x: touch.clientX, y: touch.clientY };
  };
  const touchMove = (event: TouchEvent) => {
    const touch = event.touches.length === 1 ? event.touches[0] : undefined;
    if (event.defaultPrevented || start === null || touch === undefined) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target === null || target.closest("input, textarea, [contenteditable]") !== null) return;
    const dx = Math.abs(touch.clientX - start.x);
    const dy = Math.abs(touch.clientY - start.y);
    if (!scrollsAlong(boxesFrom(target, root), dx > dy ? "x" : "y")) event.preventDefault();
  };
  root.addEventListener("touchstart", touchStart, { passive: true });
  root.addEventListener("touchmove", touchMove, { passive: false });
  return () => {
    root.removeEventListener("touchstart", touchStart);
    root.removeEventListener("touchmove", touchMove);
  };
}

function boxesFrom(target: Element, root: HTMLElement): ScrollBox[] {
  const boxes: ScrollBox[] = [];
  for (let el: Element | null = target; el !== null && el !== root; el = el.parentElement) {
    const { overflowX, overflowY } = getComputedStyle(el);
    boxes.push({
      overflowX,
      overflowY,
      scrollWidth: el.scrollWidth,
      clientWidth: el.clientWidth,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    });
  }
  return boxes;
}

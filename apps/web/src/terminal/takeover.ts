/** Finger travel past this is a swipe, which scrolls; a tap moves less. */
const TAP_SLOP_PX = 10;

/**
 * Calls `engage` when the user engages this view (foundation-design §4.3): a click, a tap, focus
 * moving into it, or the window gaining focus. A view whose page already has focus gets no focus
 * event when the user switches back to it, hence the click and the window. A swipe is not a
 * tap: a phone watching a laptop scrolls without taking the lease, which would reflow the TUI to
 * the phone's width. Returns the teardown.
 */
export function attachTakeover(element: HTMLElement, engage: () => void): () => void {
  let touchStart: { x: number; y: number } | null = null;
  const down = (event: PointerEvent) => {
    const bounds = element.getBoundingClientRect();
    if (
      event.clientX >= bounds.left + element.clientLeft + element.clientWidth ||
      event.clientY >= bounds.top + element.clientTop + element.clientHeight ||
      (event.target instanceof Element && event.target.closest(".scrollbar"))
    )
      return;
    if (event.pointerType !== "touch") engage();
    else touchStart = { x: event.clientX, y: event.clientY };
  };
  const up = (event: PointerEvent) => {
    if (event.pointerType !== "touch" || touchStart === null) return;
    const travel = Math.hypot(event.clientX - touchStart.x, event.clientY - touchStart.y);
    touchStart = null;
    if (travel < TAP_SLOP_PX) engage();
  };
  const cancel = () => (touchStart = null);
  element.addEventListener("pointerdown", down);
  element.addEventListener("pointerup", up);
  element.addEventListener("pointercancel", cancel);
  const focused = (event: FocusEvent) => {
    if (event.target !== element) engage();
  };
  element.addEventListener("focusin", focused);
  window.addEventListener("focus", engage);
  return () => {
    element.removeEventListener("pointerdown", down);
    element.removeEventListener("pointerup", up);
    element.removeEventListener("pointercancel", cancel);
    element.removeEventListener("focusin", focused);
    window.removeEventListener("focus", engage);
  };
}

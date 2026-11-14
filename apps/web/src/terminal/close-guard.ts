/**
 * In a browser tab on Linux, Windows and ChromeOS, Ctrl+W closes the tab and never reaches the page, so a
 * terminal can't have it. While Ctrl is down in a focused terminal this makes a close ask first,
 * and calls `onStayed` if the user stays. The browser keeps the W but passes on Ctrl's own keydown
 * and keyup, so the guard is armed only while Ctrl is down, and a reload or a close with the mouse
 * otherwise goes through.
 *
 * The `beforeunload` listener is added only while armed: Firefox keeps a page that has one out of
 * its back-forward cache.
 */
export function guardClose(
  page: { readonly window: EventTarget; readonly document: EventTarget },
  holdsFocus: () => boolean,
  onStayed: () => void,
): () => void {
  let armed = false;
  let stayed: ReturnType<typeof setTimeout> | undefined;
  const ask = (event: Event) => {
    if (!holdsFocus()) return;
    event.preventDefault();
    // Runs only if the page outlives the prompt.
    stayed = setTimeout(onStayed, 0);
  };
  const arm = (on: boolean) => {
    if (on === armed) return;
    armed = on;
    if (on) page.window.addEventListener("beforeunload", ask);
    else page.window.removeEventListener("beforeunload", ask);
  };
  const key = (event: Event) => arm(ctrl(event) && holdsFocus());
  // A Ctrl released over the prompt, or after Alt+Tab or a tab switch, sends this page no keyup;
  // the pointer's next event, or the blur, says it is up.
  const pointer = (event: Event) => {
    if (!ctrl(event)) arm(false);
  };
  const disarm = () => arm(false);
  // Input in capture, so the terminal can't stop it on the way; the window's own blur only.
  const listeners = [
    [page.window, "keydown", key, true],
    [page.window, "keyup", key, true],
    [page.window, "pointerdown", pointer, true],
    [page.window, "pointermove", pointer, true],
    [page.window, "blur", disarm, false],
    [page.document, "visibilitychange", disarm, false],
  ] as const;
  for (const [target, type, listener, capture] of listeners) {
    target.addEventListener(type, listener, capture);
  }
  return () => {
    disarm();
    clearTimeout(stayed);
    for (const [target, type, listener, capture] of listeners) {
      target.removeEventListener(type, listener, capture);
    }
  };
}

const ctrl = (event: Event) => Reflect.get(event, "ctrlKey") === true;

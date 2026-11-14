/**
 * In a browser tab on Linux and Windows, Ctrl+W closes the tab and never reaches the page, so a
 * terminal can't have it. While Ctrl is down in a focused terminal this makes a close ask first,
 * and calls `onStayed` if the user stays. The W is withheld but the Ctrl isn't, so a reload or a
 * close with the mouse never asks.
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
  const ask = (event: Event) => {
    event.preventDefault();
    // Runs only if the page outlives the prompt.
    setTimeout(onStayed, 0);
  };
  const arm = (on: boolean) => {
    if (on === armed) return;
    armed = on;
    if (on) page.window.addEventListener("beforeunload", ask);
    else page.window.removeEventListener("beforeunload", ask);
  };
  // Capture, so the terminal can't stop it on the way.
  const key = (event: Event) => arm(Reflect.get(event, "ctrlKey") === true && holdsFocus());
  // A Ctrl released after Alt+Tab or a tab switch sends this page no keyup.
  const disarm = () => arm(false);
  page.window.addEventListener("keydown", key, true);
  page.window.addEventListener("keyup", key, true);
  page.window.addEventListener("blur", disarm);
  page.document.addEventListener("visibilitychange", disarm);
  return () => {
    disarm();
    page.window.removeEventListener("keydown", key, true);
    page.window.removeEventListener("keyup", key, true);
    page.window.removeEventListener("blur", disarm);
    page.document.removeEventListener("visibilitychange", disarm);
  };
}

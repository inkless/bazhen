/**
 * The first `max` UTF-16 units of `text`, or one fewer where the last would be half of a
 * surrogate pair: a lone surrogate is no character, and a reader that holds text as UTF-8, as the
 * Rust CLI does, can't hold one at all.
 */
export function whole(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return cut.length < text.length && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

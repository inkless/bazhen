/**
 * The first `max` UTF-16 units of `text`, or one fewer where the last would be half of a
 * surrogate pair, which is no character: a client holding text as UTF-8 can't hold one. A copy of
 * the protocol's `whole`, since this package depends on nothing of Bazhen's.
 */
export function whole(text: string, max: number): string {
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return cut.length < text.length && last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

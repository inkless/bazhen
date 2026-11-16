/** C0 and C1 control characters, and the bidirectional embeddings, overrides and isolates. */
const unshowable = (code: number) =>
  code < 0x20 ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069);

const NONE: ReadonlySet<number> = new Set();

/**
 * Whether a client can draw the text as it is: no control character (an escape sequence, a
 * newline) and no bidirectional override that reorders the text around it, except those in
 * `allow`. Every one of them is in the Basic Multilingual Plane, so UTF-16 units find them all.
 */
export function showable(text: string, allow: ReadonlySet<number> = NONE): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (unshowable(code) && !allow.has(code)) return false;
  }
  return true;
}

/**
 * Characters that draw as nothing, or as a line break, so text holding one reads other than it
 * looks: zero-width spaces and joiners, the directional marks, the word joiner and invisible
 * operators, the byte-order mark, and the line and paragraph separators. The joiners U+200C and
 * U+200D also shape Persian, Indic and emoji text, which text held to this set can't carry.
 */
export const INVISIBLE = /[\u061c\u200b-\u200f\u2028\u2029\u2060-\u2064\ufeff]/u;

/**
 * The tag characters, which draw as nothing anywhere but a model reads as text, so they can carry
 * words to a model that a person reading the same text never sees.
 */
export const TAG_CHARACTERS = /[\u{e0000}-\u{e007f}]/u;

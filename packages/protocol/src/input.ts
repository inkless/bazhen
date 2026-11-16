const ESC = "\\x1b";

/**
 * Reports a terminal sends on its own, not keystrokes: focus in and out, and mouse reports in the
 * SGR, urxvt and X10 encodings. tmux turns focus reporting on in every view's terminal, so a view
 * sends them whatever the program asked for.
 */
const EVENT_REPORT = new RegExp(
  [
    `${ESC}\\[[IO]`,
    `${ESC}\\[<\\d+;\\d+;\\d+[Mm]`,
    `${ESC}\\[\\d+;\\d+;\\d+M`,
    `${ESC}\\[M[\\s\\S]{3}`,
  ].join("|"),
  "g",
);

/**
 * A view's input without its focus and mouse reports: what a person typed or pasted. Only that
 * asks for the lease (foundation-design §4.3); a report never does, so an old driver losing focus,
 * or a mouse moving over a view that isn't driving, can't take it.
 */
export function withoutEventReports(text: string): string {
  return text.replace(EVENT_REPORT, "");
}

const ST_OR_BEL = `(?:${ESC}\\\\|\\x07)`;

/**
 * The replies a terminal sends to queries (device attributes, mode and setting reports, window
 * reports, colours, XTVERSION). A browser's xterm.js sends them as input, so from any view they
 * would reach the program, and from a view that isn't driving they would ask for the lease.
 * Plain cursor-position reports (`CSI r;c R`) are deliberately absent: Shift+F3 is `CSI 1;2 R`.
 */
const REPLY = new RegExp(
  [
    `${ESC}\\[[?>][\\d;]*c`,
    `${ESC}\\[0n`,
    `${ESC}\\[\\?\\d+;\\d+R`,
    `${ESC}\\[\\??\\d+;\\d+\\$y`,
    `${ESC}\\[\\d+(?:;\\d+)*t`,
    `${ESC}P(?:[01]\\$r|>\\|)[^\\x1b]*${ESC}\\\\`,
    `${ESC}\\](?:4;\\d+|1[0-2]);rgb:[\\da-fA-F/]*${ST_OR_BEL}`,
  ].join("|"),
  "g",
);
const PASTE = new RegExp(`(${ESC}\\[200~[\\s\\S]*?(?:${ESC}\\[201~|$))`);

/** A view's input, as one byte per character, without the terminal's replies; pastes are kept whole. */
export function withoutReplies(text: string): string {
  return text
    .split(PASTE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(REPLY, "")))
    .join("");
}

/**
 * Whether a view's input, as one byte per character, holds anything a person typed or pasted:
 * anything beyond the terminal's replies and its focus and mouse reports. Only such input asks
 * for the lease.
 */
export function hasKeystrokes(text: string): boolean {
  return withoutEventReports(withoutReplies(text)).length > 0;
}

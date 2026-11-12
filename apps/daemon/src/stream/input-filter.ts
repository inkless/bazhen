const ESC = "\\x1b";
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
/**
 * Reports a terminal sends on its own, not keystrokes: focus in and out, and mouse reports in the
 * SGR, urxvt and X10 encodings. The driver's program gets them; they never ask for the lease, so a
 * wheel over a view that isn't driving can't take it.
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
const PASTE = new RegExp(`(${ESC}\\[200~[\\s\\S]*?(?:${ESC}\\[201~|$))`);

export interface ViewInput {
  /** The input with every terminal reply removed; pasted text is left exactly as pasted. */
  readonly bytes: Uint8Array;
  /** Whether anything is left beyond focus and mouse reports: what a person typed or pasted. */
  readonly keystrokes: boolean;
}

/** Separates what a view sent into what may reach the program and whether the user typed. */
export function classifyInput(input: Uint8Array): ViewInput {
  if (!input.includes(0x1b)) return { bytes: input, keystrokes: input.length > 0 };
  const text = Buffer.from(input.buffer, input.byteOffset, input.byteLength).toString("latin1");
  const kept = text
    .split(PASTE)
    .map((part, i) => (i % 2 === 1 ? part : part.replace(REPLY, "")))
    .join("");
  return {
    bytes: Buffer.from(kept, "latin1"),
    keystrokes: kept.replace(EVENT_REPORT, "").length > 0,
  };
}

import bold from "./font/JetBrainsMonoNFM-Bold.woff2";
import boldItalic from "./font/JetBrainsMonoNFM-BoldItalic.woff2";
import italic from "./font/JetBrainsMonoNFM-Italic.woff2";
import regular from "./font/JetBrainsMonoNFM-Regular.woff2";
import symbols from "./font/JetBrainsMonoNFM-Symbols.woff2";

const TEXT = "JetBrainsMono NFM";
/** The icons, which are the same in every style, so one face serves them all. */
const SYMBOLS = "JetBrainsMono NFM Symbols";
const SYSTEM_MONOSPACE = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/**
 * How long a terminal waits for its font before it opens on whatever font there is. A font that
 * arrives later is measured again (`TerminalFont.settled`).
 */
export const FONT_WAIT_MS = 5_000;

export interface Face {
  readonly family: string;
  readonly url: string;
  /** A range, `"400 700"`, for a face that serves every weight in it as it is. */
  readonly weight: "400" | "700" | "400 700";
  readonly style: "normal" | "italic";
}

/** The bundled faces, cut from JetBrainsMono Nerd Font Mono (`./font/README.md`). */
export const FACES: readonly Face[] = [
  { family: TEXT, url: regular, weight: "400", style: "normal" },
  { family: TEXT, url: bold, weight: "700", style: "normal" },
  { family: TEXT, url: italic, weight: "400", style: "italic" },
  { family: TEXT, url: boldItalic, weight: "700", style: "italic" },
  // The icons have no bold or italic: one face serves every style, rather than the browser
  // emboldening or slanting an icon out of its cell.
  { family: SYMBOLS, url: symbols, weight: "400 700", style: "normal" },
  { family: SYMBOLS, url: symbols, weight: "400 700", style: "italic" },
];

/**
 * The terminal's `font-family`. The text face has no icons, so an icon comes from the symbols
 * face, which has the same advance and so stays in its cell. A device's own family goes first,
 * and the bundled font still draws what it lacks.
 */
export const terminalFontFamily = (own: string | null): string =>
  [...(own === null ? [] : [own]), `"${TEXT}"`, `"${SYMBOLS}"`, SYSTEM_MONOSPACE].join(", ");

/** Settles once every face has loaded or failed, and never rejects. */
export function fontsSettled(faces: readonly { load(): Promise<unknown> }[]): Promise<void> {
  const loads = faces.map((face) => Promise.resolve().then(() => face.load()));
  return Promise.allSettled(loads).then(() => undefined);
}

/**
 * True once `settled` has, false at `deadline` if that comes first. It never rejects: a terminal
 * opens on the font there is rather than not at all.
 */
export const inTime = (settled: Promise<void>, deadline: Promise<void>): Promise<boolean> =>
  Promise.race([settled.then(() => true), deadline.then(() => false)]);

let added: FontFace[] | undefined;

/** The page's own FontFace for each bundled face, added to `document.fonts` on first use. */
function pageFaces(): FontFace[] {
  added ??= FACES.map((face) => {
    const font = new FontFace(face.family, `url("${face.url}") format("woff2")`, {
      weight: face.weight,
      style: face.style,
    });
    document.fonts.add(font);
    return font;
  });
  return added;
}

export interface TerminalFont {
  /** Whether every face had settled before the terminal's wait ran out. */
  readonly ready: Promise<boolean>;
  /** Every face has loaded or failed. */
  readonly settled: Promise<void>;
}

/**
 * Loads every bundled face, the text ones too when the device names its own family, since a family
 * this device doesn't have falls through to them. xterm.js measures its cell from the font once,
 * as it opens, and the WebGL renderer keeps each glyph it has drawn, so a terminal waits for
 * `ready` to open, and measures and draws again at `settled` if the wait ran out first.
 */
export function terminalFont(): TerminalFont {
  const settled = fontsSettled(pageFaces());
  return {
    ready: inTime(settled, new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS))),
    settled,
  };
}

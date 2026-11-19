import bold from "./font/JetBrainsMonoNFM-Bold.woff2";
import boldItalic from "./font/JetBrainsMonoNFM-BoldItalic.woff2";
import italic from "./font/JetBrainsMonoNFM-Italic.woff2";
import regular from "./font/JetBrainsMonoNFM-Regular.woff2";
import symbols from "./font/JetBrainsMonoNFM-Symbols.woff2";

const TEXT = "JetBrainsMono NFM";
/** The icons, which are the same in every style, so one face serves them all. */
const SYMBOLS = "JetBrainsMono NFM Symbols";
const SYSTEM_MONOSPACE = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';

/** How long a terminal waits for its font before it opens on whatever font there is. */
export const FONT_WAIT_MS = 5_000;

export interface Face {
  readonly family: string;
  readonly url: string;
  readonly weight: "400" | "700";
  readonly style: "normal" | "italic";
}

/** The bundled faces, cut from JetBrainsMono Nerd Font Mono (`./font/README.md`). */
export const FACES: readonly Face[] = [
  { family: TEXT, url: regular, weight: "400", style: "normal" },
  { family: TEXT, url: bold, weight: "700", style: "normal" },
  { family: TEXT, url: italic, weight: "400", style: "italic" },
  { family: TEXT, url: boldItalic, weight: "700", style: "italic" },
  { family: SYMBOLS, url: symbols, weight: "400", style: "normal" },
];

/**
 * The terminal's `font-family`. The text face has no icons, so an icon comes from the symbols
 * face, which has the same advance and so stays in its cell. A device's own family goes first,
 * and the bundled font still draws what it lacks.
 */
export const terminalFontFamily = (own: string | null): string =>
  [...(own === null ? [] : [own]), `"${TEXT}"`, `"${SYMBOLS}"`, SYSTEM_MONOSPACE].join(", ");

/** The bundled faces a terminal draws with: the text ones only if the device names no family. */
export const facesFor = (own: string | null): readonly Face[] =>
  own === null ? FACES : FACES.filter((face) => face.family === SYMBOLS);

/**
 * Resolves once every face has loaded or failed, or at `deadline`, and never rejects: a terminal
 * opens on the font there is rather than not at all.
 */
export function fontsSettled(
  faces: readonly { load(): Promise<unknown> }[],
  deadline: Promise<void>,
): Promise<void> {
  const loads = faces.map((face) => Promise.resolve().then(() => face.load()));
  return Promise.race([Promise.allSettled(loads).then(() => undefined), deadline]);
}

let added: Map<Face, FontFace> | undefined;

/** The page's own FontFace for each bundled face, added to `document.fonts` on first use. */
function pageFaces(): Map<Face, FontFace> {
  added ??= new Map(
    FACES.map((face) => {
      const font = new FontFace(face.family, `url("${face.url}") format("woff2")`, {
        weight: face.weight,
        style: face.style,
      });
      document.fonts.add(font);
      return [face, font];
    }),
  );
  return added;
}

/**
 * Loads the faces a terminal with the device's family `own` draws with. xterm.js measures its
 * cell from the font once, as it opens, and the WebGL renderer keeps each glyph it has drawn, so
 * a terminal opened before its font has loaded keeps a fallback font's grid and glyphs.
 */
export function terminalFontLoaded(own: string | null): Promise<void> {
  const page = pageFaces();
  const faces = facesFor(own).flatMap((face) => page.get(face) ?? []);
  return fontsSettled(faces, new Promise((resolve) => setTimeout(resolve, FONT_WAIT_MS)));
}

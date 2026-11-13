import type { ITheme } from "@xterm/xterm";
import type { Agent, TuiTheme } from "@bazhen/protocol";
import paletteCss from "../ui/palette.css?raw";
import { paletteOf, themeOf, toHex, type Scheme } from "../ui/token-sheet.ts";
import tokensCss from "../ui/tokens.css?raw";

const ANSI_TOKEN = "color-terminal-ansi-";
/** `bright-red` as xterm.js names it, `brightRed`. */
const camelCase = (name: string) => name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

const primitives = paletteOf(paletteCss);

/**
 * The agents whose terminal is in the other theme than `scheme`, and can be respawned in it: a TUI
 * picks its colours once, as it starts, so only a respawn brings it another theme.
 */
export const inOtherTheme = <
  A extends Pick<Agent, "state" | "theme"> & { readonly themes: readonly TuiTheme[] },
>(
  agents: readonly A[],
  scheme: TuiTheme,
): A[] =>
  agents.filter(
    (a) =>
      (a.state === "running" || a.state === "exited") &&
      a.theme !== scheme &&
      a.themes.includes(scheme),
  );

/**
 * xterm.js's colours for one theme, from the same token mapping the contrast test reads, so what
 * it passes is what the terminal draws.
 */
export function terminalTheme(scheme: Scheme, moreContrast: boolean): ITheme {
  const theme = themeOf(tokensCss, primitives, scheme, moreContrast);
  const colour = (name: string) => {
    const primitive = theme.get(`color-terminal-${name}`);
    if (primitive === undefined) throw new Error(`tokens.css has no --color-terminal-${name}`);
    return toHex(primitive);
  };
  const ansi = Object.fromEntries(
    [...theme]
      .filter(([token]) => token.startsWith(ANSI_TOKEN))
      .map(([token, primitive]) => [camelCase(token.slice(ANSI_TOKEN.length)), toHex(primitive)]),
  );
  return {
    ...ansi,
    background: colour("bg"),
    foreground: colour("text"),
    cursor: colour("cursor"),
    cursorAccent: colour("bg"),
    selectionBackground: colour("selection"),
    selectionInactiveBackground: colour("selection"),
    selectionForeground: colour("selection-text"),
  };
}

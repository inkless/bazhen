import type { ITheme } from "@xterm/xterm";
import type { Agent, HarnessId, TuiTheme } from "@bazhen/protocol";
import paletteCss from "../ui/palette.css?raw";
import { paletteOf, themeOf, toHex, type Scheme } from "../ui/token-sheet.ts";
import { pageTheme } from "../ui/theme.ts";
import tokensCss from "../ui/tokens.css?raw";

const ANSI_TOKEN = "color-terminal-ansi-";
/** `bright-red` as xterm.js names it, `brightRed`. */
const camelCase = (name: string) => name.replace(/-(\w)/g, (_, c: string) => c.toUpperCase());

const primitives = paletteOf(paletteCss);

/**
 * Whether a terminal's palette follows the page's theme, or stays dark. Codex picks its colours
 * from the background the terminal reports, which the daemon reports as black.
 */
export type TerminalPalette = "theme" | "dark";

export const harnessPalette = (harness: HarnessId): TerminalPalette =>
  harness === "codex" ? "dark" : "theme";

/**
 * Whether a change of theme leaves an agent drawing in the one it started with: a running TUI picks
 * its colours once, so only a respawn brings it the new one.
 */
export const keepsLaunchTheme = (agents: readonly Pick<Agent, "state" | "harness">[]) =>
  agents.some((a) => a.state === "running" && harnessPalette(a.harness) === "theme");

/** The background a terminal with `palette` shows now, which its TUI is started for. */
export const shownScheme = (palette: TerminalPalette): TuiTheme =>
  palette === "dark" ? "dark" : pageTheme().scheme();

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

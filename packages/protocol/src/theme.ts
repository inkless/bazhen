import { z } from "zod";

/**
 * Light or dark: the background a TUI is started for, as the client that starts it shows it. A
 * terminal keeps the one its TUI was started for, and is drawn in it.
 */
export const TuiTheme = z.enum(["light", "dark"]);
export type TuiTheme = z.infer<typeof TuiTheme>;

/**
 * The text and background a terminal in each theme is drawn in, as `#rrggbb`: tmux and the daemon
 * tell a program that asks, and the web client's terminal palette (its `--color-terminal-text`
 * and `-bg` tokens) is held to the same colours by a test. tmux also sends a themed terminal's
 * blank cells in these colours, as truecolour, so the browser draws them as given: a terminal
 * override of its text or background (more contrast, say) has to change these too, or it is
 * drawn over.
 */
export const TERMINAL_COLOURS = {
  light: { text: "#202225", background: "#fdfdfd" },
  dark: { text: "#eaebee", background: "#0f0f10" },
} as const satisfies Record<TuiTheme, { text: string; background: string }>;

/** `#rrggbb` as an OSC 10/11 reply writes it, `rgb:rrrr/gggg/bbbb`. */
export const oscColour = (hex: string) =>
  `rgb:${[1, 3, 5].map((i) => hex.slice(i, i + 2).repeat(2)).join("/")}`;

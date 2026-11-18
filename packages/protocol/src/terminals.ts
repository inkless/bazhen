import { z } from "zod";
import { HolderScreen } from "./holder.ts";

/** The most rows of history a screen read may ask for. */
export const SCREEN_HISTORY_MAX = 10_000;

/**
 * `GET /v1/terminals/:id/screen?history=<n>`: the screen shown, the alternate one while it is up,
 * as plain text after the newest `n` rows of history (0 to `SCREEN_HISTORY_MAX`, 0 if unset). A
 * line a row, each ended by `\n`, with no other control, so it can be printed to a terminal as it
 * is. `history` is how many of its rows are history: fewer than asked when the terminal holds
 * fewer, or the text would pass its cap.
 */
export const TerminalScreen = z.object({
  text: HolderScreen.shape.text,
  history: z.int().nonnegative(),
});
export type TerminalScreen = z.infer<typeof TerminalScreen>;

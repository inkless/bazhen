export type TerminalKind = "agent" | "shell";

export interface WheelContext {
  /** The program asked for mouse reports. */
  readonly mouseTracking: boolean;
  /** The program is on its alternate screen, as the daemon reports it. */
  readonly alternate: boolean;
  readonly kind: TerminalKind;
}

/**
 * - `app`: xterm.js sends the wheel to the program as mouse reports.
 * - `local`: the browser scrolls its own scrollback; nothing is sent.
 * - `arrows`: Up and Down keys, the "alternate scroll" of ordinary terminals, for `less` and `man`.
 * - `swallow`: nothing happens. An agent's TUI on its alternate screen takes arrows as
 *   prompt-history recall, so it never gets them.
 */
export type WheelAction = "app" | "local" | "arrows" | "swallow";

/** Where the wheel, a trackpad or a swipe goes (foundation-design §5.9). */
export function wheelAction({ mouseTracking, alternate, kind }: WheelContext): WheelAction {
  if (mouseTracking) return "app";
  if (!alternate) return "local";
  return kind === "shell" ? "arrows" : "swallow";
}

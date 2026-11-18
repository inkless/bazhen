import {
  HISTORY_LINES,
  HOLDER_MAX_HISTORY_LINES,
  MAX_ROWS,
  type StreamServerFrame,
} from "@bazhen/protocol";

export type TerminalKind = "agent" | "shell";

export interface WheelContext {
  /** The program asked for mouse reports. */
  readonly mouseTracking: boolean;
  /** The program is on its alternate screen (`onAlternateScreen`). */
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

/** A view's terminal, as far as which of its buffers is active. */
export interface BufferTarget {
  readonly buffer: { readonly active: { readonly type: "normal" | "alternate" } };
}

/**
 * Whether the program is on its alternate screen. A holder's bytes carry the switch, so the view's
 * own active buffer says, as of the bytes it has parsed. tmux strips it from its client's bytes,
 * so the daemon says instead (`daemonSaid`), and never for a holder: two sources would disagree
 * for as long as the view takes to parse what came before the daemon's word.
 */
export const onAlternateScreen = (term: BufferTarget, daemonSaid: boolean): boolean =>
  daemonSaid || term.buffer.active.type === "alternate";

/**
 * The scrollback a view keeps for a terminal that keeps `historyLines`, with room for a screen
 * more: a snapshot taken at more rows than the page has pushes its extra screen lines into the
 * scrollback, which would otherwise evict the oldest history. A daemon that doesn't say keeps
 * `HISTORY_LINES`; one that asks for more than any terminal can keep gets the most a terminal can,
 * so a bad frame can't make the page hold unbounded memory.
 */
export const scrollbackFor = (historyLines: number = HISTORY_LINES): number =>
  Math.min(historyLines, HOLDER_MAX_HISTORY_LINES) + MAX_ROWS;

/** What a view's terminal needs to start over for a snapshot. */
export interface SnapshotTarget {
  readonly options: { scrollback?: number };
  reset(): void;
}

/**
 * Readies a view for the snapshot `frame` starts: its scrollback sized to the terminal's depth
 * first, or the history past the old depth would be lost as it is written, then cleared.
 */
export function startSnapshot(
  term: SnapshotTarget,
  frame: Extract<StreamServerFrame, { type: "snapshot_start" }>,
): void {
  term.options.scrollback = scrollbackFor(frame.historyLines);
  term.reset();
}

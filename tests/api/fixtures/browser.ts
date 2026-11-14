import { Unicode11Addon } from "@xterm/addon-unicode11";
import headless from "@xterm/headless";
import { HISTORY_LINES, MAX_ROWS } from "@bazhen/protocol";

/** A browser's view of a terminal: what xterm.js, as the web client sets it up, shows. */
export interface BrowserScreen {
  /** Every line, scrollback first, with trailing blanks trimmed and blank lines at the end dropped. */
  readonly lines: string[];
  /** The visible screen's lines, trimmed the same way. */
  readonly screen: string[];
  /** The cursor's column and row on the visible screen, from zero. */
  readonly cursor: [number, number];
}

/** Writes `bytes` into a terminal like the web client's and reads back what it shows. */
export async function replay(
  bytes: Uint8Array,
  size: { cols: number; rows: number },
): Promise<BrowserScreen> {
  // As the page makes its terminal.
  const term = new headless.Terminal({
    ...size,
    scrollback: HISTORY_LINES + MAX_ROWS,
    allowProposedApi: true,
  });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  await new Promise<void>((resolve) => term.write(bytes, resolve));
  const buffer = term.buffer.active;
  const line = (y: number) => (buffer.getLine(y)?.translateToString(true) ?? "").trimEnd();
  const all = Array.from({ length: buffer.length }, (_, y) => line(y));
  const screen = Array.from({ length: term.rows }, (_, y) => line(buffer.viewportY + y));
  const result: BrowserScreen = {
    lines: withoutTrailingBlanks(all),
    screen: withoutTrailingBlanks(screen),
    cursor: [buffer.cursorX, buffer.cursorY],
  };
  term.dispose();
  return result;
}

/** tmux's capture, trimmed the same way as a replay, so the two compare line for line. */
export function captured(text: string): string[] {
  return withoutTrailingBlanks(text.split("\n").map((line) => line.trimEnd()));
}

function withoutTrailingBlanks(lines: string[]): string[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1] === "") end--;
  return lines.slice(0, end);
}

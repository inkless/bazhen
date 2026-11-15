// What a client mirroring a program's output into the user's terminal must undo when it stops,
// and how it recognises its own detach key under whatever keyboard protocol the program enabled.

/**
 * Turns off every mode a TUI's output can leave on in the terminal mirroring it. Written whole on
 * every exit, whatever the program did: a reset of a mode that is off is harmless, and terminals
 * ignore what they don't support. Not `RIS`, which clears the user's screen and scrollback.
 */
export const RESTORE = [
  "\x1b[?2026l", // synchronized output, first, so the terminal draws the rest
  // Kitty keeps one keyboard-flag stack per screen, and a pop deeper than the stack resets it.
  "\x1b[<99u",
  "\x1b[?1049l",
  "\x1b[<99u",
  "\x1b[>4;0m", // modifyOtherKeys
  "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1015l", // mouse
  "\x1b[?1004l\x1b[?2004l", // focus events, bracketed paste
  "\x1b[?1l\x1b>", // cursor keys, keypad
  // Resetting the scroll region homes the cursor; DECSC/DECRC keeps it where the output left
  // it. On the normal screen, after 1049l: the alternate screen's restore shares that slot.
  "\x1b7\x1b[r\x1b8",
  "\x1b[0m\x1b(B\x1b[0 q\x1b[?7h\x1b[4l\x1b[?25h", // SGR, charset, cursor shape, autowrap, insert, cursor
].join("");

export interface RawTty {
  isTTY?: boolean;
  setRawMode(on: boolean): unknown;
}

/** Cooked mode and `RESTORE`. Never throws: after SIGHUP the terminal is gone, and the caller still has work to do. */
export function restoreTerminal(tty: RawTty, write: (bytes: string) => void): void {
  try {
    if (tty.isTTY) tty.setRawMode(false);
  } catch {
    // The terminal is gone.
  }
  try {
    write(RESTORE);
  } catch {
    // The terminal is gone.
  }
}

const CTRL = 4;
const LOCKS = 64 | 128;
const ctrlOnly = (modifiers: string) => ((Number(modifiers) - 1) & ~LOCKS) === CTRL;

// Ctrl-] as kitty's `CSI 93[:alternates] ; modifiers[:event] [; text] u`, and as modifyOtherKeys'
// `CSI 27 ; modifiers ; 93 ~`.
const KITTY = /\x1b\[93(?::\d*)*;(\d+)(?::(\d+))?(?:;[\d:]*)?u/g;
const MODIFY_OTHER_KEYS = /\x1b\[27;(\d+);93~/g;

/** Index of the first Ctrl-] in a chunk of terminal input, in any encoding, or -1. */
export function findDetach(chunk: Buffer): number {
  const text = chunk.toString("latin1");
  const found = [text.indexOf("\x1d")];
  for (const m of text.matchAll(KITTY)) {
    if (ctrlOnly(m[1]!) && (m[2] === undefined || m[2] === "1")) found.push(m.index);
  }
  for (const m of text.matchAll(MODIFY_OTHER_KEYS)) if (ctrlOnly(m[1]!)) found.push(m.index);
  const hits = found.filter((i) => i >= 0);
  return hits.length === 0 ? -1 : Math.min(...hits);
}

/** Sequences in a program's output that switch the terminal's keyboard protocol. */
export const KEYBOARD_PROTOCOL = /\x1b\[(?:[<=>?][\d;:]*u|>4(?:;\d*)?m)/g;

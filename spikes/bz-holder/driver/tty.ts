// What a client mirroring a program's output into the user's terminal must undo when it stops,
// and how it recognises its own detach key under whatever keyboard protocol the program enabled.

/** What a program's output left on that a blind reset would get wrong. */
export interface ScreenState {
  alternate: boolean;
  kitty: { normal: boolean; alternate: boolean };
}

/**
 * Turns off every mode a TUI's output can leave on in the terminal mirroring it. Written on every
 * exit, whatever the program did: a reset of a mode that is off is harmless, and terminals ignore
 * what they don't support. Not `RIS`, which clears the user's screen and scrollback.
 *
 * Two parts are written only when the program's output called for them. `?1049l` also restores
 * the saved cursor on the normal screen (xterm.js does), which would move the prompt. And a
 * terminal that ignores the `<` marker reads the kitty pop `CSI < 99 u` as `CSI 99 u`, restore
 * cursor, so it is sent only to a screen the program pushed kitty flags on.
 */
export function restoreBytes(state: ScreenState): string {
  // A pop deeper than the stack empties it. Kitty keeps one stack per screen.
  const pop = (pushed: boolean) => (pushed ? "\x1b[<99u" : "");
  return [
    "\x1b[?2026l", // synchronized output, first, so the terminal draws the rest
    state.alternate ? pop(state.kitty.alternate) + "\x1b[?1049l" : "",
    pop(state.kitty.normal),
    "\x1b[>4;0m", // modifyOtherKeys
    "\x1b[?9l\x1b[?1000l\x1b[?1001l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1007l\x1b[?1015l\x1b[?1016l", // mouse
    "\x1b[?1004l\x1b[?2004l", // focus events, bracketed paste
    "\x1b[?1l\x1b>", // cursor keys, keypad
    // Resetting the scroll region homes the cursor; DECSC/DECRC keeps it where the output left
    // it. On the normal screen, after 1049l: the alternate screen's restore shares that slot.
    "\x1b7\x1b[r\x1b8",
    "\x1b[0m\x1b(B\x1b[0 q\x1b[?7h\x1b[4l\x1b[?25h", // SGR, charset, cursor shape, autowrap, insert, cursor
  ].join("");
}

const PRIVATE_MODES = /\x1b\[\?([\d;]+)([hl])/g;
const KITTY_SET = /\x1b\[[>=][\d;:]*u/g;
const SCREEN_SWITCH = new Set(["1049", "1047", "47"]);

/** Follows a program's output for the parts of `ScreenState` it changes. */
export class ScreenTracker implements ScreenState {
  alternate = false;
  kitty = { normal: false, alternate: false };
  private tail = "";

  observe(chunk: Buffer): void {
    const text = this.tail + chunk.toString("latin1");
    // A match wholly inside the tail was handled with the last chunk; one that ends past it is new.
    const fresh = (m: RegExpExecArray) => m.index + m[0].length > this.tail.length;
    const events = [
      ...[...text.matchAll(PRIVATE_MODES)]
        .filter((m) => fresh(m) && m[1]!.split(";").some((n) => SCREEN_SWITCH.has(n)))
        .map((m) => ({ at: m.index, on: m[2] === "h", kitty: false })),
      ...[...text.matchAll(KITTY_SET)].filter(fresh).map((m) => ({ at: m.index, on: true, kitty: true })),
    ].sort((a, b) => a.at - b.at);
    for (const e of events) {
      if (e.kitty) this.kitty[this.alternate ? "alternate" : "normal"] = true;
      else this.alternate = e.on;
    }
    // A sequence split across two chunks is matched on the next one.
    this.tail = text.slice(-32);
  }
}

export interface RawTty {
  isTTY?: boolean;
  setRawMode(on: boolean): unknown;
}

/** Cooked mode and `restoreBytes`. Never throws: after SIGHUP the terminal is gone, and the caller still has work to do. */
export function restoreTerminal(tty: RawTty, write: (bytes: string) => void, state: ScreenState): void {
  try {
    if (tty.isTTY) tty.setRawMode(false);
  } catch {
    // The terminal is gone.
  }
  try {
    write(restoreBytes(state));
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

// The start of a Ctrl-] escape sequence, cut off by the end of a read.
const DETACH_PREFIX = /\x1b(?:\[(?:9(?:3(?:[:;][\d:;]*)?)?|2(?:7(?:;\d*(?:;(?:9(?:3)?)?)?)?)?)?)?$/;

/**
 * Finds Ctrl-] across reads: a sequence split over two chunks would otherwise go to the program
 * half by half. A chunk ending in what may be the start of one holds that tail back until the
 * next chunk, or until `flush` (the caller's short timer, so a lone Esc still reaches the program).
 */
export class DetachScanner {
  private held = Buffer.alloc(0);

  /** The bytes to forward now, and whether Ctrl-] came after them. */
  feed(chunk: Buffer): { forward: Buffer; detach: boolean } {
    const data = Buffer.concat([this.held, chunk]);
    this.held = Buffer.alloc(0);
    const at = findDetach(data);
    if (at >= 0) return { forward: data.subarray(0, at), detach: true };
    const text = data.toString("latin1");
    const esc = text.lastIndexOf("\x1b");
    if (esc >= 0 && DETACH_PREFIX.test(text.slice(esc))) {
      this.held = data.subarray(esc);
      return { forward: data.subarray(0, esc), detach: false };
    }
    return { forward: data, detach: false };
  }

  get holding(): boolean {
    return this.held.length > 0;
  }

  flush(): Buffer {
    const out = this.held;
    this.held = Buffer.alloc(0);
    return out;
  }
}

/** Sequences in a program's output that switch the terminal's keyboard protocol. */
export const KEYBOARD_PROTOCOL = /\x1b\[(?:[<=>?][\d;:]*u|>4(?:;\d*)?m)/g;

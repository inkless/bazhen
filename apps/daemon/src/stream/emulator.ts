import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import headless from "@xterm/headless";
import type { Size } from "@bazhen/core";
import { oscColour } from "@bazhen/protocol";

/** How much history above the screen a view gets when it opens (foundation-design §12 item 2). */
export const HISTORY_LINES = 2000;

const ESC = "\x1b";
const ST = `${ESC}\\`;

/**
 * Private modes the serializer leaves out, with their defaults: the cursor's visibility and the
 * mouse report encodings. tmux sets each once and re-sends it only when it changes, so a view
 * that opens later must get them from its snapshot.
 */
const TRACKED_MODES: ReadonlyMap<number, boolean> = new Map([
  [25, true],
  [1005, false],
  [1006, false],
  [1015, false],
]);

/** The terminal closed before a snapshot of it could be taken. */
export class TerminalClosed extends Error {
  constructor() {
    super("the terminal closed");
    this.name = "TerminalClosed";
  }
}

/**
 * The daemon's copy of a terminal's screen and history, fed everything its runtime client
 * prints. It answers the client's terminal queries (foundation-design §5.4): tmux holds every
 * lone Esc for about 500 ms until all of them are answered, and a browser reply would arrive as
 * input. It also gives each view that opens the screen as it stands (§5.9).
 */
export class ScreenEmulator {
  private readonly term: headless.Terminal;
  private readonly serializer = new SerializeAddon();
  private modes = new Map(TRACKED_MODES);
  /** The scroll region tmux set, or null for the whole screen. */
  private region: readonly [number, number] | null = null;
  private disposed = false;
  /** Snapshots waiting their turn in the write queue, failed if the terminal closes first. */
  private readonly pending = new Set<(err: TerminalClosed) => void>();

  /**
   * `colours` says what a program that asks is told the terminal's text and background are, read
   * at each query: a respawn can start the terminal's next process in another theme.
   */
  constructor(
    size: Size,
    reply: (bytes: Uint8Array) => void,
    colours: () => { readonly text: string; readonly background: string },
  ) {
    this.term = new headless.Terminal({
      ...size,
      scrollback: HISTORY_LINES,
      allowProposedApi: true,
      // xterm.js drops a window-size query before any handler sees it unless this is on.
      windowOptions: { getWinSizePixels: true },
    });
    this.term.loadAddon(this.serializer);
    // The browser's width table, so a row after an emoji lands where the browser puts it.
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    const answer = (text: string) => reply(Buffer.from(text, "latin1"));
    this.term.onData(answer);
    const { parser } = this.term;
    parser.registerCsiHandler({ prefix: ">", final: "q" }, () => {
      answer(`${ESC}P>|bazhen${ST}`);
      return true;
    });
    // tmux 3.8 asks for the window's size in pixels and holds Esc until it is told. A browser's
    // pixels are unknown here, which tmux accepts as zero.
    parser.registerCsiHandler({ final: "t" }, (params) => {
      if (params[0] !== 14) return false;
      answer(`${ESC}[4;0;0t`);
      return true;
    });
    // tmux's client asks these as it attaches, and tmux answers a pane's own query from the reply
    // only when the pane's window has no style: a themed terminal is answered by tmux from its
    // style, so this is what a terminal started with no theme is told (dark, its default).
    // `10;?;?` asks for the text and then the background, as xterm reads it; a cursor colour asked
    // for after them (12) goes unanswered, as any query this terminal doesn't know. Replies end in ST
    // whatever the query ended in: xterm.js doesn't say, and the only program that asks here is
    // tmux's client, whose queries end in ST.
    const dynamic = (first: 10 | 11) => (data: string) => {
      const asked = data.split(";");
      if (asked.some((p) => p !== "?")) return false;
      const { text, background } = colours();
      const colour = { 10: text, 11: background } as const;
      for (const id of [10, 11] as const) {
        if (id >= first && id - first < asked.length) {
          answer(`${ESC}]${id};${oscColour(colour[id])}${ST}`);
        }
      }
      return true;
    };
    parser.registerOscHandler(10, dynamic(10));
    parser.registerOscHandler(11, dynamic(11));
    // The handlers below only watch: returning false lets xterm.js apply the sequence too.
    for (const [final, on] of [
      ["h", true],
      ["l", false],
    ] as const) {
      parser.registerCsiHandler({ prefix: "?", final }, (params) => {
        for (const mode of params) {
          if (typeof mode === "number" && this.modes.has(mode)) this.modes.set(mode, on);
        }
        return false;
      });
    }
    parser.registerCsiHandler({ final: "r" }, (params) => {
      const [top = 0, bottom = 0] = params.map(Number);
      const whole = top <= 1 && (bottom === 0 || bottom >= this.term.rows);
      this.region = whole ? null : [Math.max(top, 1), bottom === 0 ? this.term.rows : bottom];
      return false;
    });
    parser.registerEscHandler({ final: "c" }, () => {
      this.modes = new Map(TRACKED_MODES);
      this.region = null;
      return false;
    });
  }

  /** Puts tmux's history above the screen, oldest first, before the runtime client draws it. */
  seed(history: string): void {
    if (history === "") return;
    // The reset keeps the last history line's attributes off the screen drawn below it.
    this.term.write(`${history.split("\n").join("\r\n")}${ESC}[0m${"\r\n".repeat(this.term.rows)}`);
  }

  write(bytes: Uint8Array): void {
    this.term.write(bytes);
  }

  /**
   * The history and screen as plain VT bytes any terminal can replay, as of every byte written
   * before this call: writes are queued, and serializing waits its turn.
   */
  snapshot(): Promise<string> {
    if (this.disposed) return Promise.reject(new TerminalClosed());
    return new Promise((resolve, reject) => {
      this.pending.add(reject);
      this.term.write("", () => {
        this.pending.delete(reject);
        if (this.disposed) return;
        resolve(this.serializer.serialize({ scrollback: HISTORY_LINES }) + this.state());
      });
    });
  }

  /** Takes effect after the output already written, which was drawn at the old size. */
  resize(size: Size): void {
    this.term.write("", () => {
      this.term.resize(size.cols, size.rows);
      // A resize resets the scroll region, and tmux sets it again before relying on it.
      this.region = null;
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const reject of this.pending) reject(new TerminalClosed());
    this.pending.clear();
    this.term.dispose();
  }

  /**
   * What the serializer leaves out or gets wrong. It restores the cursor with relative moves,
   * which land one column short after a full row; an absolute position fixes that, except for a
   * cursor waiting to wrap, which the serializer leaves right and a position would lose. Setting
   * the scroll region homes the cursor, so the position follows it; a waiting cursor inside a
   * scroll region comes back at the last column instead, which tmux does not leave at rest.
   */
  private state(): string {
    const { cursorX: x, cursorY: y } = this.term.buffer.active;
    const waiting = x >= this.term.cols;
    const region = this.region === null ? "" : `${ESC}[${this.region[0]};${this.region[1]}r`;
    const cursor =
      waiting && region === "" ? "" : `${ESC}[${y + 1};${Math.min(x, this.term.cols - 1) + 1}H`;
    const modes = [...this.modes]
      .filter(([mode, on]) => TRACKED_MODES.get(mode) !== on)
      .map(([mode, on]) => `${ESC}[?${mode}${on ? "h" : "l"}`)
      .join("");
    return region + cursor + modes;
  }
}

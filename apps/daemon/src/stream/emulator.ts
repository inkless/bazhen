import { SerializeAddon } from "@xterm/addon-serialize";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import headless from "@xterm/headless";
import type { Size } from "@bazhen/core";

/** How much history above the screen a view gets when it opens (foundation-design §12 item 2). */
export const HISTORY_LINES = 2000;

const ESC = "\x1b";
const ST = `${ESC}\\`;
/** The web client's xterm.js theme defaults, so programs that ask see the colours they get. */
const COLOURS = [
  [10, "rgb:ffff/ffff/ffff"],
  [11, "rgb:0000/0000/0000"],
] as const;
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

  constructor(size: Size, reply: (bytes: Uint8Array) => void) {
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
    for (const [id, colour] of COLOURS) {
      parser.registerOscHandler(id, (data) => {
        if (data !== "?") return false;
        answer(`${ESC}]${id};${colour}${ST}`);
        return true;
      });
    }
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
    this.term.write(`${history.split("\n").join("\r\n")}${"\r\n".repeat(this.term.rows)}`);
  }

  write(bytes: Uint8Array): void {
    this.term.write(bytes);
  }

  /**
   * The history and screen as plain VT bytes any terminal can replay, as of every byte written
   * before this call: writes are queued, and serializing waits its turn.
   */
  snapshot(): Promise<string> {
    return new Promise((resolve) => {
      this.term.write("", () => {
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
    this.term.dispose();
  }

  /**
   * What the serializer leaves out. The scroll region is set inside a saved cursor, since
   * setting it homes the cursor. A cursor waiting to wrap comes back at the last column instead,
   * which matters only if tmux left it there with a scroll region set.
   */
  private state(): string {
    const region =
      this.region === null ? "" : `${ESC}7${ESC}[${this.region[0]};${this.region[1]}r${ESC}8`;
    const modes = [...this.modes]
      .filter(([mode, on]) => TRACKED_MODES.get(mode) !== on)
      .map(([mode, on]) => `${ESC}[?${mode}${on ? "h" : "l"}`)
      .join("");
    return region + modes;
  }
}

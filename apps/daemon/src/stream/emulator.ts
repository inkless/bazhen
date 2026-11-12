import headless from "@xterm/headless";

const ST = "\x1b\\";
/** The web client's xterm.js theme defaults, so programs that ask see the colours they get. */
const COLOURS = [
  [10, "rgb:ffff/ffff/ffff"],
  [11, "rgb:0000/0000/0000"],
] as const;

/**
 * A terminal emulator fed everything the daemon's runtime client prints. It answers the client's
 * terminal queries (foundation-design §5.4): tmux holds every lone Esc for about 500 ms until all
 * of them are answered, and a browser reply would arrive as input.
 */
export class ScreenEmulator {
  private readonly term: headless.Terminal;

  constructor(reply: (bytes: Uint8Array) => void) {
    this.term = new headless.Terminal({ scrollback: 0, allowProposedApi: true });
    const answer = (text: string) => reply(Buffer.from(text, "latin1"));
    this.term.onData(answer);
    this.term.parser.registerCsiHandler({ prefix: ">", final: "q" }, () => {
      answer(`\x1bP>|bazhen${ST}`);
      return true;
    });
    for (const [id, colour] of COLOURS) {
      this.term.parser.registerOscHandler(id, (data) => {
        if (data !== "?") return false;
        answer(`\x1b]${id};${colour}${ST}`);
        return true;
      });
    }
  }

  write(bytes: Uint8Array): void {
    this.term.write(bytes);
  }

  dispose(): void {
    this.term.dispose();
  }
}

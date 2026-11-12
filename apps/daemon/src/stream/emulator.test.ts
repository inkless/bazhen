import { Unicode11Addon } from "@xterm/addon-unicode11";
import headless from "@xterm/headless";
import { describe, expect, it } from "vitest";
import { ScreenEmulator, TerminalClosed } from "./emulator.ts";

const ESC = "\x1b";
const ST = `${ESC}\\`;

const SENTINEL = `${ESC}[c`;
const SENTINEL_REPLY = `${ESC}[?1;2c`;

/**
 * Feeds the emulator what tmux's client prints, and collects what it answers. A device
 * attributes query follows the output, so its answer marks the point where all of it is parsed.
 */
async function answersTo(output: string): Promise<string> {
  let replies = "";
  const { promise: parsed, resolve } = Promise.withResolvers<void>();
  const emulator = new ScreenEmulator({ cols: 80, rows: 24 }, (bytes) => {
    replies += Buffer.from(bytes).toString("latin1");
    if (replies.endsWith(SENTINEL_REPLY)) resolve();
  });
  emulator.write(Buffer.from(output + SENTINEL, "latin1"));
  await parsed;
  emulator.dispose();
  return replies.slice(0, -SENTINEL_REPLY.length);
}

describe("the daemon's screen emulator", () => {
  it("answers tmux's primary device attributes query", async () => {
    expect(await answersTo(`${ESC}[c`)).toBe(`${ESC}[?1;2c`);
  });

  it("answers tmux's secondary device attributes query", async () => {
    expect(await answersTo(`${ESC}[>c`)).toBe(`${ESC}[>0;276;0c`);
  });

  it("answers XTVERSION, which no browser terminal answers", async () => {
    expect(await answersTo(`${ESC}[>q`)).toBe(`${ESC}P>|bazhen${ST}`);
  });

  it("answers tmux 3.8's window pixel size query, with the size unknown", async () => {
    expect(await answersTo(`${ESC}[14t`)).toBe(`${ESC}[4;0;0t`);
  });

  it("answers the foreground and background colour queries", async () => {
    expect(await answersTo(`${ESC}]10;?${ST}${ESC}]11;?${ESC}\\`)).toBe(
      `${ESC}]10;rgb:ffff/ffff/ffff${ST}${ESC}]11;rgb:0000/0000/0000${ST}`,
    );
  });

  it("does not answer a sequence that sets a colour rather than asking for it", async () => {
    expect(await answersTo(`${ESC}]11;rgb:1111/1111/1111${ST}`)).toBe("");
  });
});

const size = { cols: 20, rows: 5 };

/** A terminal like the browser's: xterm.js with Unicode 11 widths. */
function browserTerminal(dimensions = size): headless.Terminal {
  const term = new headless.Terminal({ ...dimensions, scrollback: 5000, allowProposedApi: true });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  return term;
}

/** A fresh terminal, as a browser joining late would be, with the emulator's snapshot written. */
async function replayed(output: string, history = ""): Promise<headless.Terminal> {
  const emulator = new ScreenEmulator(size, () => {});
  emulator.seed(history);
  emulator.write(Buffer.from(output));
  const snapshot = await emulator.snapshot();
  emulator.dispose();
  const browser = browserTerminal();
  await new Promise<void>((resolve) => browser.write(snapshot, resolve));
  return browser;
}

function lines(term: headless.Terminal): string[] {
  const buffer = term.buffer.active;
  return Array.from({ length: buffer.length }, (_, y) =>
    (buffer.getLine(y)?.translateToString(true) ?? "").trimEnd(),
  );
}

const cursor = (term: headless.Terminal) => [
  term.buffer.active.cursorX,
  term.buffer.active.cursorY,
];

describe("the daemon's attach snapshot", () => {
  it("holds the seeded history above the screen, in order", async () => {
    const history = Array.from({ length: 30 }, (_, i) => `old ${i}`).join("\n");
    const browser = await replayed("\x1b[H\x1b[2Jnow", history);
    expect(lines(browser).slice(0, 31)).toEqual([
      ...Array.from({ length: 30 }, (_, i) => `old ${i}`),
      "now",
    ]);
  });

  it("keeps at most 2,000 lines of history", async () => {
    const history = Array.from({ length: 2500 }, (_, i) => `old ${i}`).join("\n");
    const browser = await replayed("now", history);
    expect(lines(browser)[0]).toBe("old 500");
  });

  it("puts the cursor back where the program left it", async () => {
    expect(cursor(await replayed("ab\r\ncde\x1b[1;2H"))).toEqual([1, 0]);
  });

  it("puts the cursor back on the last column after a full row, not one short of it", async () => {
    expect(cursor(await replayed(`${"x".repeat(20)}\x1b[1;20H`))).toEqual([19, 0]);
  });

  it("keeps a cursor waiting to wrap at the end of a full line", async () => {
    const browser = await replayed("x".repeat(20));
    await new Promise<void>((resolve) => browser.write("y", resolve));
    expect(lines(browser).slice(0, 2)).toEqual(["x".repeat(20), "y"]);
  });

  it("keeps the scroll region tmux set, so its scrolls stay inside it", async () => {
    const browser = await replayed("1\r\n2\r\n3\r\n4\r\n5\x1b[2;3r\x1b[4;2H");
    const cursorAfterReplay = cursor(browser);
    await new Promise<void>((resolve) => browser.write("\x1b[3;1H\n", resolve));
    expect([cursorAfterReplay, lines(browser)]).toEqual([
      [1, 3],
      ["1", "3", "", "4", "5"],
    ]);
  });

  it("measures emoji the way the browser does, so what follows one isn't shifted", async () => {
    const browser = await replayed("😀\x1b[1;5Hz");
    expect(lines(browser)[0]).toBe("😀  z");
  });

  it("restores the mouse protocol, the cursor's visibility and the modes tmux turned on", async () => {
    const emulator = new ScreenEmulator(size, () => {});
    emulator.write(Buffer.from("\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[?1004h\x1b[?25l"));
    const snapshot = await emulator.snapshot();
    emulator.dispose();
    expect(
      ["\x1b[?1000h", "\x1b[?1006h", "\x1b[?2004h", "\x1b[?1004h", "\x1b[?25l"].filter(
        (mode) => !snapshot.includes(mode),
      ),
    ).toEqual([]);
  });

  it("fails a snapshot once the terminal has closed, even one already waiting", async () => {
    const emulator = new ScreenEmulator(size, () => {});
    emulator.write(Buffer.from("x".repeat(100_000)));
    const waiting = emulator.snapshot();
    emulator.dispose();
    await expect(waiting).rejects.toThrow(TerminalClosed);
    await expect(emulator.snapshot()).rejects.toThrow(TerminalClosed);
  });

  it("keeps a history line's colours off the screen drawn below it", async () => {
    const browser = browserTerminal();
    const emulator = new ScreenEmulator(size, () => {});
    emulator.seed("\x1b[31mred history");
    emulator.write(Buffer.from("plain"));
    const snapshot = await emulator.snapshot();
    emulator.dispose();
    await new Promise<void>((resolve) => browser.write(snapshot, resolve));
    const row = lines(browser).indexOf("plain");
    expect([row > 0, browser.buffer.active.getLine(row)?.getCell(0)?.isFgDefault()]).toEqual([
      true,
      true,
    ]);
  });

  it("matches the screen at its new size after a resize", async () => {
    const emulator = new ScreenEmulator(size, () => {});
    emulator.resize({ cols: 10, rows: 3 });
    emulator.write(Buffer.from("\x1b[5;15Hz"));
    const snapshot = await emulator.snapshot();
    emulator.dispose();
    const browser = browserTerminal({ cols: 10, rows: 3 });
    await new Promise<void>((resolve) => browser.write(snapshot, resolve));
    expect(lines(browser)).toEqual(["", "", "         z"]);
  });
});

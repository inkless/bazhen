import { Unicode11Addon } from "@xterm/addon-unicode11";
import headless from "@xterm/headless";
import { expect, it } from "vitest";
import ranges from "./font/symbols-ranges.json" with { type: "json" };

const COLS = 80;

/** Every code point the bundled symbols face draws. */
const icons = ranges.flatMap(([lo = 0, hi = 0]) =>
  Array.from({ length: hi - lo + 1 }, (_, i) => lo + i),
);

/** Each cell `text` fills in a terminal with the page's Unicode 11 widths, as [character, width]. */
async function cells(text: string): Promise<[string, number][]> {
  const term = new headless.Terminal({
    cols: COLS,
    rows: 1,
    scrollback: Math.ceil(text.length / COLS) + 1,
    allowProposedApi: true,
  });
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  await new Promise<void>((resolve) => term.write(text, resolve));
  const buffer = term.buffer.active;
  const lines = Array.from({ length: buffer.length }, (_, y) => buffer.getLine(y));
  const out = lines
    .flatMap((line) => Array.from({ length: COLS }, (_, x) => line?.getCell(x)))
    .flatMap((cell) => (cell === undefined || cell.getChars() === "" ? [] : [cell]))
    .map((cell): [string, number] => [cell.getChars(), cell.getWidth()]);
  term.dispose();
  return out;
}

it("gives every icon of the bundled symbols face one cell, the width the font draws it", async () => {
  const chars = icons.map((cp) => String.fromCodePoint(cp));
  expect(icons).toHaveLength(10_610);
  expect(await cells(chars.join(""))).toEqual(chars.map((c) => [c, 1]));
});

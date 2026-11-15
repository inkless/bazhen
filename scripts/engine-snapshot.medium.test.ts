// The terminal engine's snapshot against a viewer that isn't alacritty: each stream goes straight
// into one @xterm/headless terminal, and through the engine, as its snapshot, into another. The two
// must hold the same cells, wraps, cursor, modes and active screen, history included; and then,
// given the same probe, the same again, which shows the state no cell does yet: the scroll region,
// the tab stops, the charsets and the pen. The recordings in engine-snapshot/ were made at 120x40.

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import headless from "@xterm/headless";
import { afterAll, describe, expect, it } from "vitest";
import { agentStream, sgrStream } from "../tests/support/agent-stream.ts";

const BINARY = fileURLToPath(new URL("../target/release/bazhen-holder-replay", import.meta.url));
const RECORDINGS = fileURLToPath(new URL("engine-snapshot/", import.meta.url));
const HISTORY_ROWS = 10_000;

type Terminal = InstanceType<typeof headless.Terminal>;

const dir = mkdtempSync(join(tmpdir(), "bz-engine-snapshot-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function terminal(cols: number, rows: number): Terminal {
  const term = new headless.Terminal({
    cols,
    rows,
    scrollback: HISTORY_ROWS,
    allowProposedApi: true,
  });
  // Headless stands in for the web client's @xterm/xterm, whose parser it shares; the width table
  // is the one the web client loads.
  term.loadAddon(new Unicode11Addon());
  term.unicode.activeVersion = "11";
  return term;
}

const written = (term: Terminal, data: Uint8Array | string) =>
  new Promise<void>((resolve) => term.write(data, resolve));

/** The engine's snapshot of `stream` for a viewer, from the replay bin. */
function snapshot(stream: Uint8Array, cols: number, rows: number): Uint8Array {
  const recording = join(dir, "stream.bin");
  writeFileSync(recording, stream);
  const run = spawnSync(
    BINARY,
    ["snapshot", String(cols), String(rows), String(HISTORY_ROWS), recording],
    { maxBuffer: 256 << 20 },
  );
  if (run.status !== 0) throw new Error(`replay failed: ${run.stderr.toString()}`);
  return run.stdout;
}

/**
 * A field of xterm's own state that its typings leave out: underline style and colour, link ids,
 * the cursor's visibility and style. The version is pinned, so the names hold.
 */
function internal(from: unknown, ...path: string[]): unknown {
  return path.reduce<unknown>(
    (value, key) =>
      typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined,
    from,
  );
}

type Cell = NonNullable<
  ReturnType<NonNullable<ReturnType<Terminal["buffer"]["normal"]["getLine"]>>["getCell"]>
>;

/** What a viewer draws for a cell. */
function drawn(cell: Cell | undefined): string {
  if (!cell) return "-";
  // A cell's underline style and colour mean something only while it is underlined.
  const underlined = cell.isUnderline() !== 0;
  return [
    JSON.stringify(cell.getChars() || (cell.getWidth() === 0 ? "" : " ")),
    cell.getWidth(),
    cell.getFgColorMode(),
    cell.getFgColor(),
    cell.getBgColorMode(),
    cell.getBgColor(),
    cell.isBold(),
    cell.isItalic(),
    cell.isDim(),
    cell.isUnderline(),
    underlined ? String(internal(cell, "extended", "underlineStyle")) : "",
    underlined ? String(internal(cell, "extended", "underlineColor")) : "",
    cell.isBlink(),
    cell.isInverse(),
    cell.isInvisible(),
    cell.isStrikethrough(),
    cell.isOverline(),
    String(internal(cell, "extended", "urlId")),
  ].join("|");
}

/** The cursor as a viewer shows it: whether, and in what shape. */
function cursorShown(term: Terminal): string {
  const core = internal(term, "_core", "coreService");
  return [
    internal(core, "isCursorHidden"),
    internal(core, "decPrivateModes", "cursorStyle"),
    internal(core, "decPrivateModes", "cursorBlink"),
  ]
    .map(String)
    .join("|");
}

/** Every way `got` differs from `want`, the first few of each kind: screens bottom-aligned. */
function differences(want: Terminal, got: Terminal): string[] {
  const found: string[] = [];
  if (want.buffer.active.type !== got.buffer.active.type) {
    found.push(`active ${want.buffer.active.type} != ${got.buffer.active.type}`);
  }
  for (const name of ["normal", "alternate"] as const) {
    const [a, b] = [want.buffer[name], got.buffer[name]];
    for (let r = 0; r < Math.max(a.length, b.length); r++) {
      const [la, lb] = [a.getLine(a.length - 1 - r), b.getLine(b.length - 1 - r)];
      if (!la || !lb) {
        if (la?.translateToString(true) || lb?.translateToString(true)) {
          found.push(`${name} row -${r}: present on one side only`);
        }
        continue;
      }
      if (la.isWrapped !== lb.isWrapped) found.push(`${name} row -${r}: wrap ${la.isWrapped}`);
      for (let x = 0; x < want.cols; x++) {
        const [ca, cb] = [drawn(la.getCell(x)), drawn(lb.getCell(x))];
        if (ca !== cb) found.push(`${name} row -${r} col ${x}: ${ca} != ${cb}`);
      }
    }
  }
  const [ca, cb] = [want.buffer.active, got.buffer.active];
  if (ca.cursorX !== cb.cursorX || ca.cursorY !== cb.cursorY) {
    found.push(`cursor ${ca.cursorX},${ca.cursorY} != ${cb.cursorX},${cb.cursorY}`);
  }
  const [sa, sb] = [cursorShown(want), cursorShown(got)];
  if (sa !== sb) found.push(`cursor shown ${sa} != ${sb}`);
  const theirs = new Map(Object.entries(got.modes));
  for (const [key, mode] of Object.entries(want.modes)) {
    if (theirs.get(key) !== mode) {
      found.push(`mode ${key}: ${String(mode)} != ${String(theirs.get(key))}`);
    }
  }
  return found;
}

/**
 * Output that shows what no cell does yet: a char in the pen and the shift in force, which also
 * ends a wait to wrap; a char in G1 and one in G0; tabs, which stop where the stops are; a colour,
 * which the pen's other attributes carry into; and line feeds to the screen's foot, which scroll
 * the region if the cursor is in it.
 */
const probe = (rows: number) => `p\x0eq\x0fq\r\tT\tT\tT\x1b[38;5;1mC${"\n".repeat(rows + 1)}after`;

/** How a viewer given `stream` differs from one given the engine's snapshot of it, before and
 * after the probe. */
async function differencesInAViewer(stream: Uint8Array, cols: number, rows: number) {
  const [direct, restored] = [terminal(cols, rows), terminal(cols, rows)];
  await written(direct, stream);
  await written(restored, snapshot(stream, cols, rows));
  const before = differences(direct, restored).slice(0, 5);
  await written(direct, probe(rows));
  await written(restored, probe(rows));
  const after = differences(direct, restored).slice(0, 5);
  return { before, after };
}

const SAME = { before: [], after: [] };

const recording = (name: string) => readFileSync(join(RECORDINGS, `${name}.bin`));

const text = (value: string) => new TextEncoder().encode(value);

const lines = (n: number) => Array.from({ length: n }, (_, i) => `line ${i}\r\n`).join("");

// The spike's htop recording isn't here: htop's screen depends on the machine it ran on, and it
// was never committed.
describe("xterm's own state the comparison reads", () => {
  it("is there to read, so a renamed field can't compare equal as missing on both sides", async () => {
    const term = terminal(20, 2);
    await written(term, "\x1b[4:3;58;2;1;2;3mx\x1b[0m\x1b[?25l\x1b[5 q");
    const cell = term.buffer.active.getLine(0)?.getCell(0);
    const core = internal(term, "_core", "coreService");
    const read = [
      internal(cell, "extended", "underlineStyle"),
      internal(cell, "extended", "underlineColor"),
      internal(cell, "extended", "urlId"),
      internal(core, "isCursorHidden"),
      internal(core, "decPrivateModes", "cursorStyle"),
      internal(core, "decPrivateModes", "cursorBlink"),
    ];
    expect(read.map((value) => typeof value)).toEqual([
      "number",
      "number",
      "number",
      "boolean",
      "string",
      "boolean",
    ]);
  });
});

describe("a viewer given the engine's snapshot draws what it would have drawn from the stream", () => {
  it("for the unicode recording", async () => {
    expect(await differencesInAViewer(recording("unicode"), 120, 40)).toEqual(SAME);
  });

  it("for the wrapped recording", async () => {
    expect(await differencesInAViewer(recording("wrapped"), 120, 40)).toEqual(SAME);
  });

  it("for the altscreen recording", async () => {
    expect(await differencesInAViewer(recording("altscreen"), 120, 40)).toEqual(SAME);
  });

  it("for the clear recording", async () => {
    expect(await differencesInAViewer(recording("clear"), 120, 40)).toEqual(SAME);
  });

  it("for the alt-live recording", async () => {
    expect(await differencesInAViewer(recording("alt-live"), 120, 40)).toEqual(SAME);
  });

  it("for the nvim recording", async () => {
    expect(await differencesInAViewer(recording("nvim"), 120, 40)).toEqual(SAME);
  });

  it("for an agent's output, its history included", async () => {
    expect(await differencesInAViewer(text(agentStream(400)), 120, 40)).toEqual(SAME);
  });

  it("for a colour on every word, 160 columns wide", async () => {
    expect(await differencesInAViewer(text(sgrStream(300)), 160, 50)).toEqual(SAME);
  });

  it("for a scroll region still set, scrolled inside", async () => {
    const stream = text(`${lines(60)}\x1b[5;12r\x1b[12;1H${lines(30)}in region`);
    expect(await differencesInAViewer(stream, 80, 24)).toEqual(SAME);
  });

  it("for text drawn in DEC line drawing, with G1 still shifted in", async () => {
    const box = "\x1b(0lqqk\r\nx  x\r\nmqqj\x1b(B\r\n";
    const stream = text(`${box}\x1b)0\x0eabc\x0fdef\x0e`);
    expect(await differencesInAViewer(stream, 80, 24)).toEqual(SAME);
  });

  it("for tab stops a program set", async () => {
    const stream = text("\x1b[3g\x1b[5G\x1bH\x1b[13G\x1bH\r\ta\tb\r\n\tc");
    expect(await differencesInAViewer(stream, 80, 24)).toEqual(SAME);
  });

  it("for a cursor placed under DECOM", async () => {
    const stream = text(`${lines(10)}\x1b[5;20r\x1b[?6h\x1b[3;4Hin region`);
    expect(await differencesInAViewer(stream, 80, 24)).toEqual(SAME);
  });

  it("for a cursor waiting to wrap in the last column", async () => {
    const stream = text(`${lines(5)}${"x".repeat(80)}`);
    expect(await differencesInAViewer(stream, 80, 24)).toEqual(SAME);
  });

  it("for underline styles and colours, a pen left set, and a hidden bar cursor", async () => {
    // alacritty keeps no blink or overline, so a snapshot carries neither: not drawn here.
    const styles = "\x1b[4:3;58;2;1;2;3mcurly\x1b[0m \x1b[4:2;58:5:9mdouble\x1b[0m \x1b[4:4mdotted";
    const stream = text(`${styles}\x1b[0m\x1b[1;3;48;5;22m\x1b[?25l\x1b[5 q`);
    expect(await differencesInAViewer(stream, 80, 24)).toEqual(SAME);
  });
});

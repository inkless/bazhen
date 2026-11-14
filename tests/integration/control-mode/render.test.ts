import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ConfiguredTmuxServer } from "@bazhen/host-guard";
import { ControlClient } from "./control-client.ts";
import { SIZE, Screen, fifo, newTerminal, report, sleep, spikeServer } from "./spike.ts";

const servers: ConfiguredTmuxServer[] = [];
const clients: ControlClient[] = [];
afterEach(async () => {
  for (const c of clients.splice(0)) await c.close();
  for (const s of servers.splice(0)) s.kill();
});

const E = "\x1b";
const rgb = (r: number, g: number, b: number) => `${E}[38;2;${r};${g};${b}m`;
const link = (url: string, text: string) => `${E}]8;;${url}${E}\\${text}${E}]8;;${E}\\`;

/** A TUI redrawing a status box in place, inside synchronized-output brackets, 60 frames. */
function claudeLike(): string {
  let out = "Welcome ✻ 世界 🎉\r\n";
  for (let i = 0; i < 40; i++)
    out += `${rgb(200, 120, 50)}●${E}[0m history line ${i} ${link("https://example.com/" + i, "docs")}\r\n`;
  for (let f = 0; f < 60; f++) {
    out += `${E}[?2026h`;
    if (f > 0) out += `${E}[4A`;
    out += `\r${E}[2K${rgb(90, 90, 250)}╭${"─".repeat(60)}╮${E}[0m\r\n`;
    out += `\r${E}[2K│ ${"✶✻✽"[f % 3]} Thinking… frame ${f} 中文 ${E}[1mbold${E}[0m 👩‍💻\r\n`;
    out += `\r${E}[2K${rgb(90, 90, 250)}╰${"─".repeat(60)}╯${E}[0m\r\n`;
    out += `\r${E}[2K${E}[2m? for shortcuts${E}[0m\r\n`;
    out += `${E}[?2026l`;
  }
  return out;
}

/** An inline viewport at the screen's foot, history inserted above it through a scroll region. */
function codexLike(): string {
  const rows = SIZE.rows;
  const top = rows - 6;
  let out = `${E}[2J${E}[H`;
  for (let i = 0; i < 80; i++) {
    out += `${E}[1;${top}r${E}[${top};1H`;
    out += `\r\n${rgb(120, 200, 120)}codex${E}[0m inserted history line ${i} 🎉 ${link("https://example.org", "link")}`;
    out += `${E}[r`;
    out += `${E}[${top + 2};1H${E}[2K› prompt ${i}${E}[${rows};1H${E}[2K${E}[2m${i} tokens${E}[0m`;
  }
  return out;
}

/** A full-screen program on the alternate screen, which leaves it and restores the main one. */
function altScreen(): string {
  let out = "main screen line before\r\n";
  out += `${E}[?1049h${E}[H${E}[2J`;
  for (let r = 1; r <= SIZE.rows; r++)
    out += `${E}[${r};1H${rgb(r * 9, 100, 200)}alt row ${r} ｱｲｳ${E}[0m`;
  out += `${E}[?1049l`;
  out += "main screen line after\r\n";
  return out;
}

interface Cell {
  readonly chars: string;
  readonly width: number;
  readonly fg: number;
  readonly bg: number;
  readonly bold: number;
}

function cells(screen: Screen): Cell[][] {
  const buf = screen.term.buffer.active;
  const rows: Cell[][] = [];
  for (let y = 0; y < screen.term.rows; y++) {
    const line = buf.getLine(buf.baseY + y);
    const row: Cell[] = [];
    for (let x = 0; x < screen.term.cols; x++) {
      const c = line?.getCell(x);
      row.push({
        chars: c?.getChars() ?? "",
        width: c?.getWidth() ?? 1,
        fg: c?.getFgColor() ?? 0,
        bg: c?.getBgColor() ?? 0,
        bold: c?.isBold() ?? 0,
      });
    }
    rows.push(row);
  }
  return rows;
}

function diff(a: Cell[][], b: Cell[][]): { cells: number; first: string | null } {
  let n = 0;
  let first: string | null = null;
  for (let y = 0; y < a.length; y++) {
    for (let x = 0; x < (a[y]?.length ?? 0); x++) {
      const p = a[y]?.[x];
      const q = b[y]?.[x];
      if (JSON.stringify(p) !== JSON.stringify(q)) {
        n++;
        first ??= `${y},${x}: ${JSON.stringify(p)} vs ${JSON.stringify(q)}`;
      }
    }
  }
  return { cells: n, first };
}

/** The screen's rows as text. */
const text = (s: Screen) => s.lines().slice(-SIZE.rows).join("\n");

/**
 * Plays `stream` in a pane while a control client watches, then compares the view's screen, cell
 * by cell, with tmux's own screen as `capture-pane -e` renders it into a fresh emulator.
 */
async function play(name: string, stream: string) {
  const dir = mkdtempSync(join(tmpdir(), "bz-cc-"));
  const file = join(dir, "stream");
  writeFileSync(file, stream);
  const go = fifo(dir, "go");
  const server = spikeServer(`render-${name}`);
  servers.push(server);
  const t = newTerminal(server, name, `sh -c 'read x < ${go}; cat ${file}; exec sleep 3600'`);
  const client = await ControlClient.attach(server, t.session);
  clients.push(client);
  const view = new Screen();
  client.onOutput((_p, d) => view.write(d));
  writeFileSync(go, "go\n");
  await sleep(1500);
  await view.settled();
  const captured = server.runSync(["capture-pane", "-p", "-e", "-t", t.pane]).replace(/\n$/, "");
  const [x = 0, y = 0] = server
    .runSync(["display-message", "-p", "-t", t.pane, "#{cursor_x} #{cursor_y}"])
    .trim()
    .split(" ")
    .map(Number);
  const reference = new Screen();
  reference.write(`${captured.split("\n").join("\r\n")}${E}[${y + 1};${x + 1}H`);
  await reference.settled();
  const d = diff(cells(view), cells(reference));
  const viewCursor = [view.term.buffer.active.cursorX, view.term.buffer.active.cursorY];
  const row = {
    stream: name,
    bytes: Buffer.byteLength(stream),
    textEqual: text(view) === text(reference),
    cellDiffs: d.cells,
    firstDiff: d.first,
    cursorView: viewCursor,
    cursorTmux: [x, y],
    alternateInView: view.term.buffer.active.type,
  };
  report("render", row);
  return row;
}

describe("raw pane bytes render as tmux renders them", () => {
  it.each([
    ["claude-like", claudeLike()],
    ["codex-like", codexLike()],
    ["alt-screen", altScreen()],
  ])("%s", async (name, stream) => {
    const row = await play(name, stream);
    expect(row.textEqual).toBe(true);
  });
});

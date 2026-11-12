import { describe, expect, it } from "vitest";
import { classifyInput } from "./input-filter.ts";

const ESC = "\x1b";
const ST = `${ESC}\\`;
const BEL = "\x07";

function strip(input: string): string {
  return Buffer.from(classifyInput(Buffer.from(input, "latin1")).bytes).toString("latin1");
}

function typed(input: string): boolean {
  return classifyInput(Buffer.from(input, "latin1")).keystrokes;
}

const replies: ReadonlyArray<readonly [string, string]> = [
  ["DA1", `${ESC}[?1;2c`],
  ["DA2", `${ESC}[>0;276;0c`],
  ["XTVERSION", `${ESC}P>|xterm.js(6.0.0)${ST}`],
  ["DSR status", `${ESC}[0n`],
  ["DECXCPR", `${ESC}[?12;40R`],
  ["DECRQM, private mode", `${ESC}[?2004;1$y`],
  ["DECRQM, ANSI mode", `${ESC}[4;2$y`],
  ["DECRQSS", `${ESC}P1$r0m${ST}`],
  ["window size report", `${ESC}[8;40;120t`],
  ["OSC 10 colour, ST", `${ESC}]10;rgb:dddd/dddd/dddd${ST}`],
  ["OSC 11 colour, BEL", `${ESC}]11;rgb:1111/1111/1111${BEL}`],
  ["OSC 4 palette colour", `${ESC}]4;1;rgb:cdcd/0000/0000${ST}`],
];

describe("terminal reply stripping", () => {
  it.each(replies)("drops a %s reply so it never reaches the pane", (_name, reply) => {
    expect(strip(reply)).toBe("");
  });

  it("keeps the keystrokes around a reply in order", () => {
    expect(strip(`a${ESC}[?1;2cb`)).toBe("ab");
  });

  it("keeps Shift+F3, which has the same bytes as a cursor position report", () => {
    expect(strip(`${ESC}[1;2R`)).toBe(`${ESC}[1;2R`);
  });

  it("keeps ordinary keys, arrows and Alt+Enter untouched", () => {
    const keys = `ls -la\r${ESC}[A${ESC}[1;5D${ESC}\r\x03`;
    expect(strip(keys)).toBe(keys);
  });

  it("leaves pasted text alone even when it looks like a reply", () => {
    const paste = `${ESC}[200~echo '${ESC}[?1;2c'${ESC}[201~`;
    expect(strip(paste)).toBe(paste);
  });

  it("passes focus reports through, for the driver's program", () => {
    expect(strip(`${ESC}[I${ESC}[O`)).toBe(`${ESC}[I${ESC}[O`);
  });

  it("counts focus reports alone as no keystroke, so they never take the lease", () => {
    expect(typed(`${ESC}[I${ESC}[O`)).toBe(false);
  });

  it("counts a reply alone as no keystroke", () => {
    expect(typed(`${ESC}[?1;2c`)).toBe(false);
  });

  it("counts typing as keystrokes, even next to a focus report", () => {
    expect([typed("x"), typed(`${ESC}[Ix`)]).toEqual([true, true]);
  });
});

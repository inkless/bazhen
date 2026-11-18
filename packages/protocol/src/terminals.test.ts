import { describe, expect, it } from "vitest";
import { TerminalScreen } from "./terminals.ts";

describe("a terminal's screen", () => {
  it("is text ending each row in a newline, a wide char or an empty row among them", () => {
    const screen = { text: "a  b\n\u{5bbd}\n\n", history: 1 };
    expect(TerminalScreen.parse(screen)).toEqual(screen);
  });

  it.each([
    ["an escape", "\u{1b}[31mred\n"],
    ["a carriage return", "a\r\n"],
    ["a tab", "a\tb\n"],
    ["a C1 control", "a\u{9b}\n"],
    ["DEL", "a\u{7f}\n"],
  ])("refuses text holding %s, which would act on a reader's terminal", (_, text) => {
    expect(TerminalScreen.safeParse({ text, history: 0 }).success).toBe(false);
  });

  it("refuses a negative or fractional count of history", () => {
    const counts = [-1, 0.5].map((history) => TerminalScreen.safeParse({ text: "", history }));
    expect(counts.map((parsed) => parsed.success)).toEqual([false, false]);
  });
});

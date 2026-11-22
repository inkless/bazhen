import { describe, expect, it } from "vitest";
import { holdsTerminalFocus, inTerminal } from "./focus.ts";

/** An element that knows its classes and parent, and answers `matches` for a descendant selector. */
class FakeNode {
  private readonly classes: readonly string[];
  private readonly parent: FakeNode | null;
  constructor(classes: readonly string[], parent: FakeNode | null = null) {
    this.classes = classes;
    this.parent = parent;
  }
  private has(selector: string): boolean {
    return this.classes.includes(selector.slice(1));
  }
  matches(selector: string): boolean {
    const [last = "", ...ancestors] = selector.split(" ").toReversed();
    if (!this.has(last)) return false;
    let at = this.parent;
    for (const ancestor of ancestors) {
      while (at !== null && !at.has(ancestor)) at = at.parent;
      if (at === null) return false;
      at = at.parent;
    }
    return true;
  }
}

const host = new FakeNode(["terminal-host"]);
const xterm = new FakeNode(["xterm"], host);
const textarea = new FakeNode(["xterm-helper-textarea"], xterm);
const screen = new FakeNode(["xterm-screen"], xterm);
const elsewhere = new FakeNode(["xterm-helper-textarea"], new FakeNode(["somewhere-else"]));

describe("whether focus is in a terminal", () => {
  it("is when the page's focus is a terminal's input", () => {
    expect(inTerminal(textarea)).toBe(true);
  });

  it("isn't when the focus is the host, which a scrollbar click focuses", () => {
    expect(inTerminal(host)).toBe(false);
  });

  it("isn't when the focus is another part of the terminal", () => {
    expect([screen, xterm].map((node) => inTerminal(node))).toEqual([false, false]);
  });

  it("isn't when the focus is an input outside any terminal", () => {
    expect(inTerminal(elsewhere)).toBe(false);
  });

  it("isn't when nothing has focus", () => {
    expect(inTerminal(null)).toBe(false);
  });
});

describe("whether a view holds focus", () => {
  it("does when its own input has focus", () => {
    expect(holdsTerminalFocus({ textarea }, textarea)).toBe(true);
  });

  it("doesn't when its host has focus instead of its input", () => {
    expect(holdsTerminalFocus({ textarea }, host)).toBe(false);
  });

  it("doesn't when another view's input has focus", () => {
    const other = new FakeNode(["xterm-helper-textarea"], new FakeNode(["xterm"], host));
    expect(holdsTerminalFocus({ textarea }, other)).toBe(false);
  });

  it("doesn't when nothing has focus", () => {
    expect(holdsTerminalFocus({ textarea }, null)).toBe(false);
  });

  it("doesn't before the terminal is open, whatever has focus", () => {
    expect(holdsTerminalFocus({}, null)).toBe(false);
    expect(holdsTerminalFocus({}, host)).toBe(false);
  });
});

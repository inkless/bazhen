import { describe, expect, it } from "vitest";
import { attention } from "./attention.ts";
import { InvalidTransition } from "./machine.ts";

const late = (reason: "replied" | "dismissed") => () =>
  attention.next(attention.next("open", reason), "answered");

describe("attention item", () => {
  it("refuses an inbox answer that arrives after the request was answered in the TUI", () => {
    const closed = attention.next("open", "answered_in_tui");
    expect(() => attention.next(closed, "answered")).toThrow(InvalidTransition);
  });

  it("closes on a reply or dismissal, and refuses an approval answer after either", () => {
    expect([attention.next("open", "replied"), attention.next("open", "dismissed")]).toEqual([
      "closed",
      "closed",
    ]);
    expect(late("replied")).toThrow(InvalidTransition);
    expect(late("dismissed")).toThrow(InvalidTransition);
  });

  it("closes as stale when the harness request behind it is gone", () => {
    expect(attention.next("open", "stale")).toBe("closed");
  });
});

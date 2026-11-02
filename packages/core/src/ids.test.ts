import { describe, expect, it } from "vitest";
import { isId, newId, toTerminalId } from "./ids.ts";

const zeros = (n: number) => new Uint8Array(n);

describe("newId", () => {
  it("sorts by creation time, because the timestamp leads the id", () => {
    const earlier = newId("term", 1_000, zeros);
    const later = newId("term", 2_000, zeros);
    expect(earlier < later).toBe(true);
  });

  it("marks the id as UUID version 7", () => {
    const id = newId("term");
    expect(id.slice(5 + 12, 5 + 13)).toBe("7");
    expect(isId(id)).toBe(true);
  });

  it("rejects a tmux pane id as a Bazhen id", () => {
    expect(isId("%12")).toBe(false);
  });

  it("accepts only term-prefixed ids as terminal ids", () => {
    expect(toTerminalId(newId("term"))).not.toBeNull();
    expect(toTerminalId(newId("host"))).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { isId, newId } from "./ids.ts";

const zeros = (n: number) => new Uint8Array(n);

describe("newId", () => {
  it("sorts by creation time, because the timestamp leads the id", () => {
    const earlier = newId("term", 1_000, zeros);
    const later = newId("term", 2_000, zeros);
    expect(earlier < later).toBe(true);
  });

  it("marks the id as UUID version 7", () => {
    const id = newId("agent");
    expect(id.slice("agent_".length + 12, "agent_".length + 13)).toBe("7");
  });

  it("refuses a random source that returns too few bytes", () => {
    expect(() => newId("msg", 0, () => new Uint8Array(8))).toThrow(RangeError);
  });
});

describe("isId", () => {
  it("rejects a tmux pane id as a Bazhen id", () => {
    expect(isId("term", "%12")).toBe(false);
  });

  it("accepts an id only under its own prefix", () => {
    const id = newId("term");
    expect(isId("term", id)).toBe(true);
    expect(isId("agent", id)).toBe(false);
  });

  it("does not take one prefix for a longer one that starts with it", () => {
    const id = newId("attn");
    expect([isId("attn", id), isId("att", id)]).toEqual([true, false]);
  });
});

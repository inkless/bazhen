import { describe, expect, it } from "vitest";
import { mayScroll, scrollsAlong, SLOP_PX, type ScrollBox } from "./pan-guard.ts";

const box = (change: Partial<ScrollBox> = {}): ScrollBox => ({
  overflowX: "visible",
  overflowY: "visible",
  scrollWidth: 100,
  clientWidth: 100,
  scrollHeight: 100,
  clientHeight: 100,
  ...change,
});

describe("where a drag has somewhere to scroll", () => {
  it("is a pane on the way up that scrolls along the drag and has more than it shows", () => {
    const list = box({ overflowY: "auto", scrollHeight: 400 });
    expect(scrollsAlong([box(), list], "y")).toBe(true);
  });

  it("is nowhere on the key bar dragged up and down, though it scrolls sideways", () => {
    const bar = box({ overflowX: "auto", scrollWidth: 600 });
    expect([scrollsAlong([box(), bar], "y"), scrollsAlong([box(), bar], "x")]).toEqual([
      false,
      true,
    ]);
  });

  it("is nowhere in a pane that could scroll but holds no more than it shows", () => {
    expect(scrollsAlong([box({ overflowY: "auto" })], "y")).toBe(false);
  });

  it("is nowhere in content that overflows a box that clips it", () => {
    expect(scrollsAlong([box({ overflowY: "hidden", scrollHeight: 400 })], "y")).toBe(false);
  });
});

describe("a drag's direction", () => {
  const list = box({ overflowY: "auto", scrollHeight: 400 });

  it("isn't decided by its first few pixels, which may lean the other way", () => {
    expect(mayScroll([list], 2, 1)).toBe(true);
  });

  it("is decided once the finger has moved past the slop", () => {
    expect([mayScroll([list], 0, SLOP_PX), mayScroll([list], SLOP_PX, 0)]).toEqual([true, false]);
  });

  it("moves nothing, from its first pixel, where nothing scrolls either way", () => {
    expect(mayScroll([box()], 1, 0)).toBe(false);
  });
});

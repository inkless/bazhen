import { describe, expect, it } from "vitest";
import { readDetachKeys } from "./detach-keys.ts";

describe("detach keys", () => {
  it("reads ctrl- keys in either case and shows them as a person reads them", () => {
    expect(readDetachKeys("ctrl-],CTRL-p,q")).toEqual({ shown: "Ctrl-] Ctrl-P q" });
  });

  // JavaScript lowercases the Kelvin sign to k; the CLI's Rust folds ASCII alone.
  it("folds only ASCII's case, as the CLI does", () => {
    expect(readDetachKeys("ctrl-K")).toHaveProperty("problem");
  });

  it("refuses a sequence that starts with Escape", () => {
    expect(readDetachKeys("ctrl-[,x")).toEqual({
      problem: "can't start with ctrl-[: that is Escape, which every arrow key starts with",
    });
  });
});

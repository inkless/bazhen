import { describe, expect, it } from "vitest";
import { readDetachKeys } from "./detach-keys.ts";

/** What a refusal of a name says, quoting it as `quoted`. */
const refusal = (quoted: string) => ({
  problem: `${quoted} isn't a key: name ctrl- with a letter or one of @ [ \\ ] ^ _, or one printable character other than a comma`,
});

describe("detach keys", () => {
  it("reads ctrl- keys in either case and shows them as a person reads them", () => {
    expect(readDetachKeys("ctrl-],CTRL-p,q")).toEqual({ shown: "Ctrl-] Ctrl-P q" });
  });

  // JavaScript lowercases the Kelvin sign to k; the CLI's Rust folds ASCII alone.
  it("folds only ASCII's case, as the CLI does", () => {
    expect(readDetachKeys("ctrl-K")).toHaveProperty("problem");
  });

  it("quotes a name it refuses without a byte a terminal acts on", () => {
    expect(["\u001b[2J", 'a"b\\', "\u00e9\u{1f600}"].map(readDetachKeys)).toEqual([
      refusal(String.raw`"\u{1b}[2J"`),
      refusal(String.raw`"a\"b\\"`),
      refusal(String.raw`"\u{e9}\u{1f600}"`),
    ]);
  });

  it("refuses a sequence that starts with Escape", () => {
    expect(readDetachKeys("ctrl-[,x")).toEqual({
      problem: "can't start with ctrl-[: that is Escape, which every arrow key starts with",
    });
  });
});

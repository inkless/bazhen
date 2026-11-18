import { describe, expect, it } from "vitest";
import { defaultRuntimeRefusal } from "./runtimes.ts";

const none = { installed: null, reason: "no build at target/release-holder" } as const;
const built = {
  installed: { binary: "/s/holder/ab/bazhen-holder", build: "ab", installDir: "/s/holder" },
} as const;

describe("starting with a default runtime", () => {
  it("refuses the holder default with no build installed, saying why and how to use tmux", () => {
    expect(defaultRuntimeRefusal("holder", none, "/c/config.toml")).toBe(
      "no holder can be started for new terminals: no build at target/release-holder. " +
        'To run them on tmux instead, set runtime.default = "tmux" in /c/config.toml',
    );
  });

  it("starts with a build installed, or on tmux with none", () => {
    expect([
      defaultRuntimeRefusal("holder", built, "/c/config.toml"),
      defaultRuntimeRefusal("tmux", none, "/c/config.toml"),
    ]).toEqual([null, null]);
  });
});

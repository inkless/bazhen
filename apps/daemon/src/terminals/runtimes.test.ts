import { describe, expect, it } from "vitest";
import { defaultRuntimeRefusal } from "./runtimes.ts";

const none = { installed: null, reason: "no build at target/release-holder" } as const;
const built = {
  installed: { binary: "/s/holder/ab/bazhen-holder", build: "ab", installDir: "/s/holder" },
} as const;

describe("starting with a default runtime", () => {
  it("refuses the holder default with no build installed, naming the key, the file and why", () => {
    expect(defaultRuntimeRefusal("holder", none, "/c/config.toml")).toBe(
      'runtime.default = "holder" (/c/config.toml), but no holder can be started: ' +
        "no build at target/release-holder",
    );
  });

  it("starts with a build installed, or on tmux with none", () => {
    expect([
      defaultRuntimeRefusal("holder", built, "/c/config.toml"),
      defaultRuntimeRefusal("tmux", none, "/c/config.toml"),
    ]).toEqual([null, null]);
  });
});

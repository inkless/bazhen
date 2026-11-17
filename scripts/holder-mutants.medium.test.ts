import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MACOS_FILES } from "./holder-mutants.ts";

describe("the macos group", () => {
  it("holds every module the holder compiles only on macOS, so none of them lands in rest", () => {
    const lib = readFileSync(
      new URL("../crates/bazhen-holder/src/lib.rs", import.meta.url),
      "utf8",
    );
    const modules = [
      ...lib.matchAll(/#\[cfg\(target_os = "macos"\)\]\s*(?:pub(?:\([^)]*\))? )?mod (\w+);/g),
    ].map((m) => `${m[1]}.rs`);
    expect(modules).toEqual(["macos.rs"]);
    expect(MACOS_FILES).toEqual(modules);
  });
});

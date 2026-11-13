import { describe, expect, it } from "vitest";
import { cliVersion } from "./version.ts";

describe("codex --version", () => {
  it("is read as the version after the program's name", () => {
    expect(cliVersion("codex-cli 0.166.0\n")).toBe("0.166.0");
  });

  it("names no version when the output isn't one", () => {
    expect([cliVersion(""), cliVersion("error: unknown flag"), cliVersion("codex-cli")]).toEqual([
      null,
      null,
      null,
    ]);
  });
});

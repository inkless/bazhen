import { accessSync, constants, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { testHome } from "../support/holder-home.ts";
import { TMUX_REFUSAL } from "../support/holder-setup.ts";

function executable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** What a shell would run as `tmux`: the first executable of that name on PATH. */
const tmuxOnPath = () =>
  String(process.env["PATH"])
    .split(":")
    .map((dir) => join(dir, "tmux"))
    .find(executable);

describe("the holder tests' tmux isolation", () => {
  it("finds a refusal of the run's own, not tmux, as tmux on PATH", () => {
    const refusal = `${testHome()}/bin/tmux`;
    expect(tmuxOnPath()).toBe(refusal);
    expect(readFileSync(refusal, "utf8")).toBe(TMUX_REFUSAL);
  });

  it("runs outside any tmux client, with tmux's socket directory an empty one of its own", () => {
    const dir = String(process.env["TMUX_TMPDIR"]);
    expect(process.env["TMUX"]).toBeUndefined();
    expect(dir).toBe(`${testHome()}/tmux`);
    expect(readdirSync(dir)).toEqual([]);
  });
});

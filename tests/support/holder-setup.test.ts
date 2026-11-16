import { describe, expect, it } from "vitest";
import { start } from "./holder-setup.ts";

/** The steps `start` took, in order, with the sandbox check refusing or not. */
async function steps(sandboxed: boolean): Promise<string[]> {
  const took: string[] = [];
  const run = start({
    requireSandbox: () => {
      took.push("check");
      if (!sandboxed) throw new Error("Refusing to run");
    },
    sweep: async () => took.push("sweep"),
    prepare: () => took.push("prepare"),
  });
  await run.catch(() => took.push("refused"));
  return took;
}

describe("the holder suite's setup", () => {
  it("refuses off a sandbox before it sweeps or makes anything", async () => {
    expect(await steps(false)).toEqual(["check", "refused"]);
  });

  it("checks, sweeps, then makes the run's home on a sandbox", async () => {
    expect(await steps(true)).toEqual(["check", "sweep", "prepare"]);
  });
});

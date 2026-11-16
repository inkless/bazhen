import { describe, expect, it } from "vitest";
import { holderLines } from "./holder.ts";

const NEW = "3f9a0c1d2e4b5a67";
const OLD = "81ce22d09b7f4410";
const binary = `/s/holder/${NEW}/bazhen-holder`;
const on = (build: string | null, protocol = ["1.2"]) => ({ terminalId: "t", build, protocol });

describe("doctor's holder lines", () => {
  it("say why none is installed", () => {
    const none = {
      binary: null,
      build: null,
      reason: "x isn't built; run pnpm build",
      holders: [],
    };
    expect(holderLines(none)).toEqual(["holder: none installed (x isn't built; run pnpm build)"]);
  });

  it("count terminals by the build they run, marking older and unknown builds", () => {
    const holders = [on(NEW), on(OLD), on(NEW), on(null), on(OLD, ["1.3"])];
    expect(holderLines({ binary, build: NEW, reason: null, holders })).toEqual([
      `holder: build ${NEW} (${binary})`,
      `  2 terminals on ${NEW}, protocol 1.2`,
      `  1 terminal on ${OLD} (older build; restart to upgrade), protocol 1.2`,
      "  1 terminal on an unknown build, protocol 1.2",
      `  1 terminal on ${OLD} (older build; restart to upgrade), protocol 1.3`,
    ]);
  });
});

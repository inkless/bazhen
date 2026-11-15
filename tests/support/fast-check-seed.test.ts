import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import { FAST_CHECK_SEED, fastCheckSeed } from "./fast-check-seed.ts";

describe("fastCheckSeed", () => {
  it("is the constant unless FC_SEED gives one", () => {
    expect([{}, { FC_SEED: "" }, { FC_SEED: "-42" }].map(fastCheckSeed)).toEqual([
      FAST_CHECK_SEED,
      FAST_CHECK_SEED,
      -42,
    ]);
  });

  it("refuses an FC_SEED that isn't an integer", () => {
    expect(() => fastCheckSeed({ FC_SEED: "random" })).toThrow("FC_SEED is not an integer: random");
  });

  it("seeds fast-check before a test file runs", () => {
    expect(fc.readConfigureGlobal().seed).toBe(fastCheckSeed(process.env));
  });
});

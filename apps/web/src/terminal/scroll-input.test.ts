import { describe, expect, it } from "vitest";
import { GLIDE_STEPS_PER_FRAME, glideSteps } from "./scroll-input.ts";

describe("a glide's rows a frame", () => {
  it("holds a program fed arrow keys or mouse reports to a few a frame, either way", () => {
    expect([glideSteps(40, "arrows"), glideSteps(-40, "app"), glideSteps(2, "arrows")]).toEqual([
      GLIDE_STEPS_PER_FRAME,
      -GLIDE_STEPS_PER_FRAME,
      2,
    ]);
  });

  it("moves the page's own scrollback by all of them", () => {
    expect(glideSteps(40, "local")).toBe(40);
  });
});

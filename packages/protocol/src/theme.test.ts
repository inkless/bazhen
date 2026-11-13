import { describe, expect, it } from "vitest";
import { oscColour } from "./theme.ts";

describe("terminal colours", () => {
  it("writes a colour as an OSC 10/11 reply does, each channel doubled to 16 bits", () => {
    expect(oscColour("#0f80fd")).toBe("rgb:0f0f/8080/fdfd");
  });
});

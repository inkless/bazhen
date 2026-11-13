import { describe, expect, it } from "vitest";
import { statusText } from "./status.ts";

describe("terminal status line", () => {
  it("names the device another view drives from, or says another view when it is on none", () => {
    expect([
      statusText({ kind: "taken", device: "Phone" }),
      statusText({ kind: "taken", device: undefined }),
    ]).toEqual([
      "Viewing — Phone is driving; click or type to take over",
      "Viewing — another view is driving; click or type to take over",
    ]);
  });
});

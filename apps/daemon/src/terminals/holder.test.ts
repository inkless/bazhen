import { describe, expect, it } from "vitest";
import { holderDoctor } from "./holder.ts";

const installed = { binary: "/s/holder/0123456789abcdef/bazhen-holder", build: "0123456789abcdef" };

describe("what doctor reports of holders", () => {
  it("names the installed build and the build each answering holder runs", async () => {
    const runtime = {
      builds: async () => [{ terminalId: "term_a", build: "fedcba9876543210", protocol: ["1.2"] }],
    };
    const install = { installed: { ...installed, installDir: "/s/holder" } };
    expect(await holderDoctor(install, runtime)).toEqual({
      ...installed,
      reason: null,
      holders: [{ terminalId: "term_a", build: "fedcba9876543210", protocol: ["1.2"] }],
    });
  });

  it("says why nothing is installed, with no runtime to ask", async () => {
    const install = { installed: null, reason: "not built" };
    expect(await holderDoctor(install, null)).toEqual({
      binary: null,
      build: null,
      reason: "not built",
      holders: [],
    });
  });
});

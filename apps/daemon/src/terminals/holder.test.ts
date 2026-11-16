import { describe, expect, it } from "vitest";
import { holderDoctor } from "./holder.ts";

const installed = { binary: "/s/holder/0123456789abcdef/bazhen-holder", build: "0123456789abcdef" };

describe("what doctor reports of holders", () => {
  it("names the installed build, and each answering holder with its build, socket and memory", async () => {
    const held = {
      terminalId: "term_a",
      build: "fedcba9876543210",
      protocol: ["1.2"],
      contained: true,
      socket: "/run/holders/term_a.sock",
      holderPid: 4242,
      stats: { engineBytes: 1, rss: 2, ringBytes: 3, historyLines: 4 },
    };
    const runtime = {
      builds: async () => [held],
    };
    const install = { installed: { ...installed, installDir: "/s/holder" } };
    expect(await holderDoctor(install, runtime)).toEqual({
      ...installed,
      reason: null,
      holders: [held],
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

import { describe, expect, it } from "vitest";
import { newId } from "./ids.ts";
import { laterGeneration, type RuntimeRef } from "./runtime.ts";

const terminalId = newId("term");

const recorded: RuntimeRef = {
  terminalId,
  runtime: "holder",
  locator: {
    socket: `/run/bazhen/holders/${terminalId}.sock`,
    holderPid: "4100",
    holderStart: "900",
    childPid: "4101",
    childStart: "901",
    generation: "2",
  },
};

const found = (locator: Record<string, string>): RuntimeRef => ({
  ...recorded,
  locator: { ...recorded.locator, ...locator },
});

const replaced = found({ childPid: "4300", childStart: "950", generation: "3" });

describe("a terminal found at a generation the daemon didn't issue", () => {
  it("is one whose holder runs a later process than the recorded one", () => {
    expect([
      laterGeneration(recorded, replaced),
      laterGeneration(recorded, found({ childPid: "4300", childStart: "950", generation: "7" })),
    ]).toEqual([true, true]);
  });

  it("is not the recorded process, nor an earlier one", () => {
    expect([
      laterGeneration(recorded, recorded),
      laterGeneration(recorded, found({ generation: "1" })),
    ]).toEqual([false, false]);
  });

  it("is not one run by a different holder, whatever its generation", () => {
    expect([
      laterGeneration(recorded, found({ ...replaced.locator, holderPid: "5000" })),
      laterGeneration(recorded, found({ ...replaced.locator, holderStart: "999" })),
    ]).toEqual([false, false]);
  });

  it("is not one on another terminal or runtime", () => {
    expect([
      laterGeneration(recorded, { ...replaced, terminalId: newId("term") }),
      laterGeneration(recorded, { ...replaced, runtime: "tmux" }),
    ]).toEqual([false, false]);
  });

  it("is never concluded from a generation that isn't a whole number", () => {
    expect([
      laterGeneration(recorded, found({ generation: "" })),
      laterGeneration(recorded, found({ generation: "3a" })),
      laterGeneration(found({ generation: "x" }), replaced),
      laterGeneration({ ...recorded, locator: {} }, replaced),
    ]).toEqual([false, false, false, false]);
  });

  it("is a later pane process on tmux's locator too", () => {
    const pane: RuntimeRef = {
      terminalId: recorded.terminalId,
      runtime: "tmux",
      locator: { serverPid: "70", serverStart: "5", paneId: "%3", panePid: "71", generation: "0" },
    };
    const respawned = { ...pane, locator: { ...pane.locator, panePid: "88", generation: "1" } };
    const otherServer = { ...respawned, locator: { ...respawned.locator, serverPid: "90" } };
    expect([laterGeneration(pane, respawned), laterGeneration(pane, otherServer)]).toEqual([
      true,
      false,
    ]);
  });
});

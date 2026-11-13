import { describe, expect, it } from "vitest";
import { newId, ProcessState, StaleIncarnation, TerminalUnconfirmed } from "@bazhen/core";
import {
  EnvironmentUnavailable,
  forceable,
  fromEnvironment,
  ServerUnconfirmed,
  TerminalReplaced,
} from "./commands.ts";

const terminalId = newId("term");
const as = (cause: unknown) => {
  try {
    fromEnvironment("shell x", cause);
  } catch (err) {
    return err;
  }
  return undefined;
};

describe("an environment's failure as a command's", () => {
  it("names what the caller can act on, and anything else as the environment out of reach", () => {
    expect([
      as(new StaleIncarnation(terminalId, "gone")),
      as(new TerminalUnconfirmed(terminalId, null)),
      as(new Error("tmux unreachable")),
    ]).toEqual([
      expect.any(TerminalReplaced),
      expect.any(ServerUnconfirmed),
      expect.any(EnvironmentUnavailable),
    ]);
  });

  it("lets force record past an unconfirmed server or an unreachable one, never a replaced pane", () => {
    expect([
      forceable(new TerminalUnconfirmed(terminalId, null)),
      forceable(new Error("tmux unreachable")),
      forceable(new StaleIncarnation(terminalId, "pane-replaced")),
      forceable(new ProcessState(terminalId, "running")),
    ]).toEqual([true, true, false, false]);
  });
});

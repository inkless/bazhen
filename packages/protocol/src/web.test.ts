import { describe, expect, it } from "vitest";
import * as generated from "./gen/constants.ts";
import * as hand from "./index.ts";
import { oscColour } from "./theme.ts";
import { AgentName, AgentRef } from "./web.ts";

describe("the web's protocol", () => {
  it("refuses a name with the rule a person can read, not the pattern", () => {
    for (const typed of ["-not-a-name", "a".repeat(41), "agent_0193d1e5f3a87c4e9b2d6f7a8c1e3b5d"]) {
      const refused = AgentName.safeParse(typed);
      expect(refused.error?.issues.map((i) => i.message)).toEqual([
        "a name is 1 to 40 letters, digits, - or _, starts with a letter or digit, and isn't an id",
      ]);
    }
  });

  it("takes each constant the Rust protocol writes at the value the hand protocol gave it", () => {
    const pairs = {
      MAX_ROWS: [generated.MAX_ROWS, hand.MAX_ROWS],
      HOLDER_MAX_HISTORY_LINES: [generated.HOLDER_MAX_HISTORY_LINES, hand.HOLDER_MAX_HISTORY_LINES],
      AGENT_NAME_MAX: [generated.AGENT_NAME_MAX, hand.AGENT_NAME_MAX],
      BUILTIN_ROLES: [generated.BUILTIN_ROLES, hand.BUILTIN_ROLES],
      TERMINAL_COLOURS: [generated.TERMINAL_COLOURS, hand.TERMINAL_COLOURS],
      HISTORY_LINES: [generated.HISTORY_LINES, hand.HISTORY_LINES],
      MESSAGE_WAIT_MAX_MESSAGES: [
        generated.MESSAGE_WAIT_MAX_MESSAGES,
        hand.MESSAGE_WAIT_MAX_MESSAGES,
      ],
    };
    for (const [name, [emitted, written]] of Object.entries(pairs)) {
      expect({ [name]: emitted }).toEqual({ [name]: written });
    }
  });

  it("draws a terminal in colours an OSC reply can spell, as the holder tells a program", () => {
    const drawn = Object.values(generated.TERMINAL_COLOURS).flatMap((c) => [c.text, c.background]);
    expect(drawn).toHaveLength(4);
    for (const colour of drawn) {
      expect(colour).toMatch(/^#[0-9a-f]{6}$/);
      expect(oscColour(colour)).toMatch(/^rgb:([0-9a-f]{4})\/([0-9a-f]{4})\/([0-9a-f]{4})$/);
    }
  });

  it("takes a name, and an id as a reference", () => {
    expect(AgentName.safeParse("agent_tools").success).toBe(true);
    expect(AgentRef.safeParse("agent_0193d1e5f3a87c4e9b2d6f7a8c1e3b5d").success).toBe(true);
  });
});

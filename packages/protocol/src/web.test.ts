import { describe, expect, it } from "vitest";
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

  it("takes a name, and an id as a reference", () => {
    expect(AgentName.safeParse("agent_tools").success).toBe(true);
    expect(AgentRef.safeParse("agent_0193d1e5f3a87c4e9b2d6f7a8c1e3b5d").success).toBe(true);
  });
});

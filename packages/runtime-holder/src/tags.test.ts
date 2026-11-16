import { newId, type TerminalTags } from "@bazhen/core";
import { describe, expect, it } from "vitest";
import { decodeTags, encodeTags, unlinked } from "./tags.ts";

const agentId = newId("agent");

describe("a holder terminal's tags", () => {
  it("round-trips every kind of terminal's tags", () => {
    const all: TerminalTags[] = [
      { kind: "agent", agentId },
      { kind: "agent", agentId, harnessSession: "sess-1" },
      { kind: "shell" },
      { kind: "shell", linkedAgentId: agentId },
    ];
    expect(all.map((tags) => decodeTags(encodeTags(tags)))).toEqual(all);
  });

  it("writes a tag only when it has a value", () => {
    expect(encodeTags({ kind: "agent", agentId, harnessSession: "" })).toEqual({
      kind: "agent",
      agentId,
    });
  });

  it("reads tags Bazhen didn't write as none of its terminals", () => {
    const foreign = [{}, { kind: "agent" }, { kind: "agent", agentId: "a1" }, { kind: "pane" }];
    expect(foreign.map(decodeTags)).toEqual([null, null, null, null]);
  });

  it("drops only a shell's agent link when unlinked", () => {
    const tags = encodeTags({ kind: "shell", linkedAgentId: agentId });
    expect(decodeTags(unlinked({ ...tags, other: "kept" }))).toEqual({ kind: "shell" });
    expect(unlinked({ ...tags, other: "kept" })).toEqual({ kind: "shell", other: "kept" });
  });
});

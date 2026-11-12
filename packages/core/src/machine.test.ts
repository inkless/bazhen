import { describe, expect, it } from "vitest";
import { InvalidTransition, machine } from "./machine.ts";

const door = machine<"open" | "shut" | "gone", "close" | "open" | "remove">("door", {
  open: { close: "shut" },
  shut: { open: "open", remove: "gone" },
  gone: {},
});

describe("machine", () => {
  it("follows the table", () => {
    expect(door.next("open", "close")).toBe("shut");
  });

  it("names the machine, state and event it refused", () => {
    expect(() => door.next("open", "remove")).toThrow(
      expect.objectContaining({ machine: "door", from: "open", event: "remove" }),
    );
    expect(() => door.next("open", "remove")).toThrow(InvalidTransition);
  });

  it("says whether a state accepts an event, as the table does", () => {
    expect([door.accepts("shut", "remove"), door.accepts("open", "remove")]).toEqual([true, false]);
  });

  it("treats a state that accepts nothing as final", () => {
    expect([door.isFinal("gone"), door.isFinal("shut")]).toEqual([true, false]);
  });
});

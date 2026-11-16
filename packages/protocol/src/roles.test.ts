import { describe, expect, it } from "vitest";
import { Role, RolesResponse } from "./roles.ts";

describe("role schemas", () => {
  it("takes a role the user defined, and refuses one no file could be named", () => {
    expect(
      ["reviewer", "qa-2", "Lead", "-x", "a".repeat(33)].map((r) => Role.safeParse(r).success),
    ).toEqual([true, true, false, false, false]);
  });

  it("refuses a role list whose limit isn't a positive count", () => {
    const role = {
      key: "worker",
      title: "Worker",
      description: "",
      grants: [],
      singlePerTask: false,
      maxActiveTasks: 0,
      prompt: "p",
      source: "builtin",
    };
    expect(RolesResponse.safeParse({ roles: [role], problems: [] }).success).toBe(false);
    expect(
      RolesResponse.safeParse({ roles: [{ ...role, maxActiveTasks: null }], problems: [] }).success,
    ).toBe(true);
  });
});

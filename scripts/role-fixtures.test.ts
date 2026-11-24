import { describe, expect, it } from "vitest";
import { BUILTIN_ROLES, RoleDefinition } from "@bazhen/protocol";
import { SYNTAX, roleFixture } from "./role-fixtures.ts";

const files = roleFixture();
type Case = { name: string; key: string; text: string } & (
  | { role: unknown }
  | { problem: string; syntax?: true }
);

const cases: readonly Case[] = JSON.parse(files["cases.json"] ?? "[]");
const builtins = RoleDefinition.array().parse(JSON.parse(files["builtins.json"] ?? "[]"));
/** For each refused case, whether it is marked a syntax error and whether its words say so. */
const marked = cases.flatMap((c) =>
  "problem" in c ? [[c.syntax === true, c.problem.startsWith(SYNTAX)]] : [],
);

describe("the role fixture", () => {
  it("records the built-in roles as the daemon reads them", () => {
    expect(builtins.map((r) => r.key)).toEqual([...BUILTIN_ROLES]);
  });

  it("marks a problem a YAML syntax error raises, and only that", () => {
    expect(marked.filter(([a, b]) => a !== b)).toEqual([]);
    expect(marked.map(([a]) => a)).toContain(true);
  });

  it("records roles read as well as problems", () => {
    expect(cases.map((c) => "role" in c)).toContain(true);
    expect(cases.map((c) => "role" in c)).toContain(false);
  });

  it("names its cases apart", () => {
    expect(new Set(cases.map((c) => c.name)).size).toBe(cases.length);
  });
});

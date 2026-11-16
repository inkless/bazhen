import type { RoleDefinition } from "@bazhen/protocol";
import { describe, expect, it } from "vitest";
import { resolveRoles } from "./roles.ts";

const role = (
  key: string,
  grants: string[] = [],
  source: RoleDefinition["source"] = "builtin",
): RoleDefinition => ({
  key,
  title: key,
  description: "",
  grants,
  singlePerTask: false,
  maxActiveTasks: null,
  prompt: `the ${source} ${key}`,
  source,
});

const BUILTINS = [role("coordinator", ["worker"]), role("worker")];
const user = (key: string, grants: string[] = []) => ({
  file: `${key}.md`,
  role: role(key, grants, "user"),
});

describe("the roles in force", () => {
  it("replaces a built-in whole with the user's file of its key, in the built-in's place", () => {
    const { book, problems } = resolveRoles(BUILTINS, [user("worker")]);
    expect(problems).toEqual([]);
    expect(book.roles.map((r) => [r.key, r.prompt])).toEqual([
      ["coordinator", "the builtin coordinator"],
      ["worker", "the user worker"],
    ]);
  });

  it("adds a user role of a new key, which a built-in may then be replaced to grant", () => {
    const { book } = resolveRoles(BUILTINS, [user("tester"), user("coordinator", ["tester"])]);
    expect(book.roles.map((r) => r.key)).toEqual(["coordinator", "worker", "tester"]);
    expect(book.rules("coordinator").grants).toEqual(["tester"]);
  });

  it("skips a user role that grants itself, and the built-in of its key stands", () => {
    const { book, problems } = resolveRoles(BUILTINS, [user("coordinator", ["coordinator"])]);
    expect(book.get("coordinator")?.source).toBe("builtin");
    expect(problems).toEqual([
      { file: "coordinator.md", problem: "a coordinator can't grant its own role" },
    ]);
  });

  it("skips a role whose grant names a role that was itself skipped", () => {
    const { book, problems } = resolveRoles(BUILTINS, [
      user("tester", ["ghost"]),
      user("lead", ["tester"]),
    ]);
    expect(book.roles.map((r) => r.key)).toEqual(["coordinator", "worker"]);
    expect(problems.map((p) => p.file)).toEqual(["tester.md", "lead.md"]);
  });
});

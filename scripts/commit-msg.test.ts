import { describe, expect, it } from "vitest";
import { subjectProblem } from "./commit-msg.ts";

describe("subjectProblem", () => {
  it("accepts Conventional Commit subjects", () => {
    expect(
      ["feat(core): add lost state", "fix: handle EOF", "refactor(web)!: rename props"].map(
        subjectProblem,
      ),
    ).toEqual([undefined, undefined, undefined]);
  });

  it("rejects a subject without a type", () => {
    expect(subjectProblem("add lost state")).toMatch(/not a Conventional Commit/);
  });

  it("rejects a subject over 72 characters in total", () => {
    const subject = `feat(core): ${"x".repeat(61)}`;
    expect([subjectProblem(subject.slice(0, 72)), subjectProblem(subject)]).toEqual([
      undefined,
      expect.stringMatching(/73 characters/),
    ]);
  });

  it("accepts fixup!, squash! and amend! subjects that name a valid subject", () => {
    expect(
      ["fixup!", "squash!", "amend!", "fixup! fixup!"].map((prefix) =>
        subjectProblem(`${prefix} feat(core): add lost state`),
      ),
    ).toEqual([undefined, undefined, undefined, undefined]);
  });

  it("rejects a fixup! whose remainder is not a Conventional Commit", () => {
    expect(subjectProblem("fixup! add lost state")).toMatch(/not a Conventional Commit/);
  });

  it("budgets 72 characters for the remainder after the fixup! prefix", () => {
    const remainder = `feat(core): ${"x".repeat(61)}`;
    expect([
      subjectProblem(`fixup! ${remainder.slice(0, 72)}`),
      subjectProblem(`squash! ${remainder}`),
    ]).toEqual([undefined, expect.stringMatching(/73 characters/)]);
  });

  it("accepts git's default revert subject", () => {
    const long = `feat(core): ${"x".repeat(60)}`;
    expect([
      subjectProblem('Revert "feat(core): add lost state"'),
      subjectProblem(`Revert "${long}"`),
    ]).toEqual([undefined, undefined]);
  });
});

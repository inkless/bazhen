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

  it("accepts git's fixup! subjects", () => {
    expect(subjectProblem("fixup! feat(core): add lost state")).toBeUndefined();
  });

  it("accepts git's default revert subject", () => {
    expect(subjectProblem('Revert "feat(core): add lost state"')).toBeUndefined();
  });
});

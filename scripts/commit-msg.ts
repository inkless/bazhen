// Checks a commit message's subject against Conventional Commits (docs/standards/review.md).

import { readFileSync } from "node:fs";
import { isMain } from "./is-main.ts";

const TYPES = [
  "feat",
  "fix",
  "docs",
  "style",
  "refactor",
  "perf",
  "test",
  "build",
  "ci",
  "chore",
  "revert",
];
const SUBJECT = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9-]+\\))?!?: \\S.*$`);
const MAX_LENGTH = 72;

// `rebase --autosquash` folds these into the commit they name, so what follows the prefix is that
// commit's subject and must pass the rule on its own.
const AUTOSQUASH = /^(fixup|squash|amend)! /;
// `git revert` writes `Revert "<original subject>"`. The original subject was checked when it
// landed, and the wrapper alone can push it past the length budget, so it is exempt.
const REVERT = /^Revert ".+"$/;

/** Why the subject is rejected, or undefined when it is acceptable. */
export function subjectProblem(subject: string): string | undefined {
  if (REVERT.test(subject)) return undefined;
  const autosquash = AUTOSQUASH.exec(subject)?.[0];
  if (autosquash !== undefined) return subjectProblem(subject.slice(autosquash.length));
  if (!SUBJECT.test(subject)) {
    return (
      `Commit subject is not a Conventional Commit: "${subject}"\n` +
      `Use \`type(scope): subject\`, with type one of ${TYPES.join(", ")}.`
    );
  }
  if (subject.length > MAX_LENGTH) {
    return `Commit subject is ${subject.length} characters (at most ${MAX_LENGTH}): "${subject}"`;
  }
  return undefined;
}

if (isMain(import.meta)) {
  const file = process.argv[2];
  if (file === undefined) throw new Error("usage: node scripts/commit-msg.ts <message-file>");
  const problem = subjectProblem(readFileSync(file, "utf8").split("\n")[0] ?? "");
  if (problem !== undefined) {
    console.error(problem);
    process.exit(1);
  }
}

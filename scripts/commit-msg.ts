// Checks a commit message's subject against Conventional Commits (docs/standards/review.md).

import { readFileSync } from "node:fs";

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

// git writes these subjects itself: `rebase --autosquash` rewrites fixup!/squash!/amend! before
// they land, and `git revert` writes `Revert "<original subject>"`.
const GIT_GENERATED = /^((fixup|squash|amend)! |Revert ".+"$)/;

/** Why the subject is rejected, or undefined when it is acceptable. */
export function subjectProblem(subject: string): string | undefined {
  if (GIT_GENERATED.test(subject)) return undefined;
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

if (import.meta.main) {
  const file = process.argv[2];
  if (file === undefined) throw new Error("usage: node scripts/commit-msg.ts <message-file>");
  const problem = subjectProblem(readFileSync(file, "utf8").split("\n")[0] ?? "");
  if (problem !== undefined) {
    console.error(problem);
    process.exit(1);
  }
}

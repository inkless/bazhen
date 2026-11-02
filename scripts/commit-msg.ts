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
const SUBJECT = new RegExp(`^(${TYPES.join("|")})(\\([a-z0-9-]+\\))?!?: \\S.{0,70}$`);

const file = process.argv[2];
if (file === undefined) throw new Error("usage: node scripts/commit-msg.ts <message-file>");
const subject = readFileSync(file, "utf8").split("\n")[0] ?? "";

// git's own fixup!/squash! subjects are rewritten by `rebase --autosquash` before they land.
if (!/^(fixup|squash|amend)! /.test(subject) && !SUBJECT.test(subject)) {
  console.error(
    `Commit subject is not a Conventional Commit: "${subject}"\n` +
      `Use \`type(scope): subject\` (at most 72 characters), with type one of ${TYPES.join(", ")}.`,
  );
  process.exit(1);
}

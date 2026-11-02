# Review checklist

Use it on your own diff before committing, and on anyone else's. The order follows Google's
code-review guide: design problems make everything after them moot. Skip what the tooling has
already checked (listed at the end).

1. **Design.** Does the change belong in this package (`code.md` § Boundaries)? Is there a
   simpler shape? Does it add a seam, a dependency or a protocol change that needs a reason in
   the commit message?
2. **Behaviour.** Does it do what the commit says? Look at the edge cases: an empty input, a
   process that exits immediately, the daemon restarting mid-operation, two clients at once.
3. **Complexity.** Could a reader new to the code follow it? Is anything built for a future need
   that isn't real yet?
4. **Tests.** For each new test, ask _what change to the source would make this fail?_ Then check
   the falsify result, or the `Control:` trailer, says the same. Is each test the smallest size
   that can fail for the right reason (`testing.md` § Sizes)?
5. **Errors.** Are expected failures typed? Is anything swallowed? Are third-party errors
   wrapped at the seam?
6. **Names and comments.** Do names say what things are? Does every comment explain a _why_ the
   code can't?
7. **Docs.** If behaviour, a command or a rule changed, are `AGENTS.md`, the README or these
   standards updated in the same commit?

The commit subject is a Conventional Commit, `type(scope): subject`. The body says why the
change was made, and records any `Control:` trailers.

## Already checked by tooling

`pnpm check` runs on every commit, through the pre-commit hook:

- formatting;
- lint, including the import matrix, the test rules and `any`;
- types, for sources, tests and scripts;
- small, medium and integration tests;
- sibling tests.

The commit-msg hook checks the subject and runs the falsification harness. Don't spend review
time on any of these. If one of them is wrong, fix the check.

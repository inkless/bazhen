# Review checklist

Use it on your own diff before pushing, and on anyone else's. The order follows Google's
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
   the falsify result, or a `Control:` trailer on the branch, says the same. Is each test the
   smallest size that can fail for the right reason (`testing.md` § Sizes)?
5. **Errors.** Are expected failures typed? Is anything swallowed? Are third-party errors
   wrapped at the seam?
6. **Names and comments.** Do names say what things are? Does every comment explain a _why_ the
   code can't?
7. **Rust** (`rust.md`). Is every `unsafe` in the one listed module, each block's `SAFETY:`
   comment a real proof of the invariant it names? Does a decoder return an error, never panic,
   on any input, and is a decoder the check can't see listed in `FUZZED_DECODERS` with a
   target: one of text from outside, a closure, one a macro generates, or a function that opens
   its own source (`io::stdin()` inside)? Are a library's errors typed with thiserror, and wrapped with their source? Is a
   new dependency pinned in `[workspace.dependencies]`, with a reason in the commit, and its
   default features trimmed? Does each new Rust test that falsify reports INVALID have a
   `Control:` trailer that breaks the code the test names, and does a behaviour the daemon can observe have its test in the black-box suite
   too?
8. **Docs.** If behaviour, a command or a rule changed, are `AGENTS.md`, the README or these
   standards updated in the same commit?

The commit body says why the change was made, and records any `Control:` trailers.

## Already checked by tooling

- **pre-commit** runs oxfmt and oxlint (with the `pnpm lint` flags) on the staged files, through
  lint-staged.
- **CI** runs `pnpm check`, the full gate: the standards check (sibling tests, agent context,
  skills), the protocol schema drift check, lint (including the import matrix, the test rules and
  `any`), the format check, types for sources, tests and scripts, and the small and medium
  tests. CI then runs the integration, api and e2e suites, which no host runs (`pnpm test:real`
  runs them in a container). It runs on Linux, on Node 24 and 26; macOS is off while the repo is
  private. On a pull request it also runs `pnpm test:falsify` against the target
  branch; run it yourself before pushing.
- **`pnpm check`'s Rust gates** run rustfmt's check, clippy with pedantic and the restriction
  lints, cargo-deny and nextest on the whole workspace, and the standards check rejects lint
  suppressions in `crates/`, a lint configuration other than the standard's, and a dependency
  not pinned in the workspace. Falsify runs each new Rust test against mutants of the code the
  branch changed, prints the mutant that killed it, and fails until a `Control:` trailer names
  each test none killed; item 7 checks the control is real.

The pre-commit hook is installed by `pnpm install` (husky); never skip it with `--no-verify`.
Run `pnpm check` yourself before opening a pull request. Don't
spend review time on any of these. If one of them is wrong, fix the check.

---
name: bz-write-rust-test
description: Writes a test for Bazhen's Rust crates in this repository (crates/*) and proves it can fail, with a unit test, a proptest property, or an insta snapshot of a protocol frame. Use when changing Bazhen's source in this repository under crates/, to add behaviour or fix a bug, before writing the implementation. Not for TypeScript (bz-write-unit-test), not for tests that need real tmux (bz-write-integration-test), and not for operating a running Bazhen.
---

# Write a Rust test for Bazhen's source

**Gate: no new behaviour without a test that fails first, for the right reason.** Falsify can't
revert a Rust test's source without reverting the test, so it runs each new test against mutants
of the code the branch changed instead. CI fails the pull request until each new test is either
KILLED by one of those mutants or named by a `Control:` trailer you recorded by hand.

## Steps

1. **Pick the kind from what the code does** (`docs/standards/rust.md` § Tests):
   - one behaviour of private code: a `#[test]` in the file's `#[cfg(test)] mod tests`;
   - a crate's public API: a file in the crate's `tests/`;
   - a decoder or a state machine: a proptest property, beside the unit tests;
   - an encoder's frame, which other languages read: an insta snapshot. insta isn't a dependency
     yet: add it to `[workspace.dependencies]` first (`docs/standards/rust.md` § Dependencies).
2. **Name the behaviour, not the function,** as a sentence in snake case:
   `refuses_every_reply_cut_short`, not `test_parse_reply`.
3. **Copy the nearest exemplar** in `crates/bazhen-hook/src/main.rs`:
   - plain behaviour: `splits_stdout_from_stderr_by_byte_count`;
   - a table of bad inputs: `refuses_malformed_replies`;
   - a socket pair, no daemon: `daemon_wrote` and the `read_response` tests;
   - properties: `mod properties`, a strategy per input and `prop_assert_eq!` in the body.
4. **Run it and watch it fail:** `pnpm test:rust <name>`. It must fail on an
   assertion. A compile error proves nothing.
5. Implement until it passes, then run `pnpm check`.
6. **Commit, then run `pnpm test:falsify`.** Each new test it reports KILLED has its control: the
   mutant printed beside it. For each one it reports INVALID, break the code the test names
   (swap a comparison, drop a check, return a constant), run the test, see it fail on its
   assertion, and restore the code. Add a trailer to a commit on the branch naming the test by
   the path nextest lists (falsify prints the trailer to fill in):
   `Control: <module::path::test_name>: <what you broke> -> <how the test failed>`.

## Checklist

- [ ] Each test name states one behaviour.
- [ ] I watched each new test fail on an assertion, and each one falsify didn't kill with a
      mutant has a `Control:` trailer naming it.
- [ ] A behaviour the daemon or a user can observe also has its test in the black-box suite
      (`tests/api`), which drives the binary from outside.
- [ ] `pnpm check` passes.

## Gotchas

- **`unwrap` and `expect` are fine in tests, not in the code they test.** `clippy.toml` allows
  them in `#[test]` functions and `#[cfg(test)]` items only. A helper in a crate's `tests/`
  directory outside those fails `pnpm lint:rust`, so it returns a `Result`.
- **No `#[allow]` to quiet a lint, in tests either.** The standards check rejects it. Fix the code.
- **A mutant leaves a `proptest-regressions` file.** Delete it after a control; commit one only
  when it records a real bug the property found.
- **Don't wait with `sleep`.** Bound the wait instead, as the socket tests do with a read timeout,
  so a hang fails fast with what it saw.
- **nextest runs each test in its own process,** so a test can't lean on state another left.
- **Never snapshot screen contents.** insta is for protocol frames only; assert the bytes that
  matter.

## Rationalizations

| Thought                                     | Answer                                                                   |
| ------------------------------------------- | ------------------------------------------------------------------------ |
| "The types make it obviously correct"       | The types don't check the framing. Then the test is cheap                |
| "No mutant killed it, but it's fine"        | Then nothing yet shows it can fail. Break the code by hand and see       |
| "A property test is overkill for a parser"  | Parsers are where the panics are. One strategy finds what ten cases miss |
| "I'll `#[ignore]` it for now"               | Fix it or delete it                                                      |
| "The `Control:` trailer for one covers all" | Each unkilled test needs a trailer naming it; falsify fails on any other |

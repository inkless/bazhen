# Testing standards

A test is worth keeping when it would fail if the behaviour it names broke. Everything on this
page serves that rule, or keeps tests from hurting the machine and each other.

| Rule                                                                               | Enforced by                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------- |
| A test that passes without the change it accompanies is rejected                   | CI on pull requests (`pnpm test:falsify`)   |
| A new test that can't be judged by reverting needs at least one `Control:` trailer | CI on pull requests (`pnpm test:falsify`)   |
| Small tests (`*.test.ts`) touch no files, sockets, processes or databases          | `pnpm lint`                                 |
| No `.only`, `.skip`, assertion-free tests, or conditionals inside tests            | `pnpm lint` (vitest rules)                  |
| Every source file with runtime code has a sibling test, or a named covering test   | `pnpm check` (`scripts/check-standards.ts`) |
| Test files type-check                                                              | `pnpm typecheck` (`tsconfig.dev.json`)      |
| Tests can't reach a real tmux server, and leave none running                       | integration setup and teardown              |
| Test runs refuse to start when the machine is short of PTYs                        | integration and medium setup                |
| Fakes over mocks; behaviour-named tests; no snapshots of terminal output           | review                                      |
| Behaviour tests are black-box: they reach the daemon only through public surfaces  | review                                      |

## Sizes

Size is about what a test touches, and the file name declares it. The sizes follow _Software
Engineering at Google_.

| Size   | File                          | May touch                            | Runs in                                |
| ------ | ----------------------------- | ------------------------------------ | -------------------------------------- |
| small  | `src/**/x.test.ts`            | memory only, including `app.request` | `pnpm test`, in parallel, milliseconds |
| small  | `scripts/*.test.ts`           | memory only                          | `pnpm test`                            |
| medium | `src/**/x.medium.test.ts`     | temporary files, SQLite              | `pnpm test:medium`                     |
| medium | `scripts/*.medium.test.ts`    | temporary files, git, subprocesses   | `pnpm test:medium`                     |
| medium | `tests/integration/*.test.ts` | a private tmux server, real PTYs     | `pnpm test:integration`, one worker    |
| large  | `tests/api/*.test.ts`         | the daemon as a process, tmux, CLIs  | `pnpm test:api`, one worker            |
| large  | `tests/e2e/*.spec.ts`         | daemon, web client and browser       | `pnpm test:e2e`                        |

Write the smallest test that can fail for the right reason. E2E tests cover only wiring that
crosses processes; a behaviour that a medium test can reach belongs in a medium test.

## Black-box behaviour tests

The daemon may be rewritten in another language later (a Rust daemon is revisited at M2). What
makes that cheap is a suite that certifies the rewrite unchanged, so behaviour tests are written
against the daemon's public surfaces, never its TypeScript internals.

- **The black-box suite is its own package.** It depends only on `@bazhen/protocol`, starts the
  daemon as a separate process, and drives it only over HTTP, WebSocket, the CLI and tmux. A
  behaviour a user or an agent can observe gets its test there.
- **Unit, medium and integration tests may be internal.** They import the packages they test, and
  would be rewritten with the code.
- `tests/api` is that suite. It starts the daemon under a temporary `BAZHEN_HOME` and runs the
  real harness CLIs pinned in its `package.json`. No agent reaches a real model, and the daemon
  never sees the developer's own credentials: its environment is built from a short allowlist.

## Falsification

Every new test must be shown to fail without the code it covers.

- **Revert check.** CI runs it on every pull request, and you run `pnpm test:falsify` before
  pushing. It takes the branch's new tests and runs them against the source as it was at the
  branch's merge base with main (origin/main when there is a remote), in a throwaway
  worktree (`scripts/falsify.ts`). Only committed work counts. Each test comes out as one of:
  - **KILLED** — it failed. Good.
  - **SURVIVED** — it passed without the change, so it can't detect the change. The check
    fails. Only a test that directly imports a reverted file can survive.
  - **INVALID** — no verdict: it couldn't load, timed out, was skipped, its title couldn't be
    read or isn't unique, or it passed but imports no reverted file, so it is unrelated to the
    source change (a characterization or property test of existing code); a branch that adds
    tests without a source change also lands here.
    Every test of a brand-new function is INVALID, because the function doesn't exist before
    the change.

  Titles are read from added lines that look like `it(...)` or `test(...)` calls, so a fixture
  string such as `'it("fixture", f)'` in a test file counts as a test. It can't be found in the
  run, comes out INVALID and asks for a control: the safe direction.

- **Controls for INVALID tests.** Break the code by hand: swap a comparison, delete a branch, or
  return a constant. Confirm the test fails on its assertion, not on a crash or a timeout, then
  restore the code. Record it as a trailer in a commit message on the branch:
  `Control: <what you broke> -> <how the test failed>`, one per INVALID test. The check accepts
  any one trailer on the branch, so the reviewer is who holds you to the rest. Never bypass a
  hook with `--no-verify`.

Two lessons from the scaffold's controls:

- **A test that fails only by timing out is weak.** Assert the thing you care about first, then
  wait, so a failure prints the value you expected.
- **A control can find a real bug.** One control caught a race where a fast-exiting process
  destroyed its tmux session before `remain-on-exit` applied.

`pnpm test:falsify --base <ref>` judges the branch against another base. Stryker-style mutation
scores are not a gate, because their cost and equivalent mutants make the number meaningless.

## Hermeticity

A test owns everything it touches and leaves nothing behind.

- **Paths.** Medium and integration runs get a temporary `BAZHEN_HOME`. Unit runs point it at a
  path that doesn't exist. Never read or write the real Bazhen directories.
- **tmux.** Each run gets its own tmux socket directory (`TMUX_TMPDIR`) and runs outside any
  tmux client (`TMUX` unset). Any tmux command a test runs, even a bare `tmux` with no `-L`,
  lands on a throwaway server, never on the user's sessions, the agent fleet or a real daemon.
  Still, name each server with `testSocket(label)` so a leak says which test caused it, and kill
  it in `afterAll`. Teardown fails the run on any server still alive.
- **PTYs are a machine-wide resource.** macOS has 511, and a leak starves every terminal on the
  machine. The setup refuses to run above 420 in use. A runtime change that opens PTYs needs a
  lifecycle test that repeats the operation and asserts the handle count returns to its baseline
  (`ptyHandleCount()`). Linux uses the same fraction of `/proc/sys/kernel/pty/max`;
  `BZ_PTY_CUTOFF` exists only for machines with a different PTY limit, never to get a leaky run
  through.
- **Ports.** Use free ports, never fixed ones, because parallel worktrees run the same suites.

## Writing the test

- **Name the behaviour,** for example "becomes lost only when the runtime answers and the target
  is absent", not "nextState works".
- **Prefer real objects and fakes to mocks.** Build inputs with a small builder, like `spec()` in
  `tmux-runtime.test.ts`. A test whose setup is longer than its assertion is testing the mocks.
- **Inject time and randomness,** as `newId()` does, instead of faking timers.
- **Poll with `expect.poll`,** which fails with the last value it saw. Never `sleep` to wait for
  something.
- **Write property tests for state tables.** Generate random event sequences with fast-check and
  assert invariants (`packages/core/src/machine.property.test.ts`). Keep the walk and the
  predicates at module scope, and only `fc.assert` inside the test.
- **Test HTTP routes through `app.request`,** with a `Host` header from the allowlist
  (`apps/daemon/src/http/app.test.ts`).
- **Migrations.** A shipped migration is never edited. A new migration gets a medium test that
  opens a database at the previous schema and upgrades it.
- **No snapshots of terminal output.** Assert the specific bytes or screen content that matter.
- **Flaky tests are bugs.** There are no retries. Fix the race, or delete the test and record why.

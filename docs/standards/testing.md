# Testing standards

A test is worth keeping when it would fail if the behaviour it names broke. Everything on this
page serves that rule, or keeps tests from hurting the machine and each other.

| Rule                                                                               | Enforced by                                 |
| ---------------------------------------------------------------------------------- | ------------------------------------------- |
| A test that passes without the change it accompanies is rejected                   | CI on pull requests (`pnpm test:falsify`)   |
| A test falsify can't judge needs a `Control:` trailer; a Rust test, one naming it. | CI on pull requests (`pnpm test:falsify`)   |
| Small tests (`*.test.ts`) touch no files, sockets, processes or databases          | `pnpm lint`                                 |
| No `.only`, `.skip`, assertion-free tests, or conditionals inside tests            | `pnpm lint` (vitest rules)                  |
| Every source file with runtime code has a sibling test, or a named covering test   | `pnpm check` (`scripts/check-standards.ts`) |
| Test files type-check                                                              | `pnpm typecheck` (`tsconfig.dev.json`)      |
| Tests that run real tmux start only on a disposable host (container or CI)         | integration, api and e2e setup              |
| Tests can't reach a real tmux server, and leave none running                       | integration setup and teardown              |
| Test runs refuse to start when the machine is short of PTYs                        | integration and api setup                   |
| Fakes over mocks; behaviour-named tests; no snapshots of terminal output           | review                                      |
| Behaviour tests are black-box: they reach the daemon only through public surfaces  | review                                      |

Rust tests follow this page too, with the differences in `rust.md` § Tests: nextest, proptest,
insta for protocol frames, cargo-fuzz for every function that takes bytes from outside, and
falsify judging new tests by mutating the change instead of reverting it, with a `Control:`
trailer naming each test it can't judge.

## Sizes

Size is about what a test touches, and the file name declares it. The sizes follow _Software
Engineering at Google_.

| Size   | File                          | May touch                            | Runs in                                |
| ------ | ----------------------------- | ------------------------------------ | -------------------------------------- |
| small  | `src/**/x.test.ts`            | memory only, including `app.request` | `pnpm test`, in parallel, milliseconds |
| small  | `scripts/*.test.ts`           | memory only                          | `pnpm test`                            |
| medium | `src/**/x.medium.test.ts`     | temporary files, SQLite              | `pnpm test:medium`                     |
| medium | `scripts/*.medium.test.ts`    | temporary files, git, subprocesses   | `pnpm test:medium`                     |
| medium | `tests/integration/*.test.ts` | a private tmux server, real PTYs     | `pnpm test:real integration`           |
| large  | `tests/api/*.test.ts`         | the daemon as a process, tmux, CLIs  | `pnpm test:real api`                   |
| large  | `tests/e2e/*.spec.ts`         | daemon, web client and browser       | `pnpm test:real e2e`                   |

`pnpm check` runs the small and medium tests on the host; none of them runs tmux or an agent.
The other three sizes run real tmux, so they run only on a disposable host: the test container
(`pnpm test:real`, which builds it from the worktree without mounting it) or a CI runner. A
disposable host is Linux with `/etc/bazhen-disposable-host`; their setup refuses to start
anywhere else. Never create that file on a machine you work on. Inside a container or CI they
are the `pnpm test:integration`, `test:api` and `test:e2e` scripts, one worker each. Each run's
containers have no network. A run removes its containers, image and build context on every exit
it sees, Ctrl-C, SIGTERM and SIGHUP included, and gives each cleanup command 30 seconds; a second
signal abandons the cleanup. What a run killed outright or abandoned left, the next run on the
same machine removes: it sweeps the stopped containers, images and contexts whose owning process
is gone, and an image only once no container uses it.
Docker's build cache keeps the layers, so repeat runs are fast; BuildKit's garbage collection
bounds it, and `docker builder prune` reclaims it on a machine of your own. Under Podman, where
`docker` is the podman-docker shim, nothing bounds the cache; `podman image prune` reclaims it on
a machine of your own.

**Remove every scratch Docker image and container you build,** by its own tag or name, when you
are done with it. Several agents share one Docker host, so never prune, and never remove an image
you did not build: another run may be using it.

Write the smallest test that can fail for the right reason. E2E tests cover only wiring that
crosses processes; a behaviour that a medium test can reach belongs in a medium test.

## Black-box behaviour tests

The daemon may be rewritten in another language later (a Rust daemon is revisited at M2). What
makes that cheap is a suite that certifies the rewrite unchanged, so behaviour tests are written
against the daemon's public surfaces, never its TypeScript internals.

- **The black-box suite is its own package.** It depends only on `@bazhen/protocol`, and on
  `@bazhen/host-guard` to run tmux: a dependency-free safety guard, not a daemon internal. It
  starts the daemon as a separate process, and drives it only over HTTP, WebSocket, the CLI and
  tmux. A behaviour a user or an agent can observe gets its test there.
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
  run, comes out INVALID and asks for a control: the safe direction. An existing test whose call
  line only became `async` is left out, since it isn't new; one removed and added again with the
  same call line is judged. A test whose body changes under an unchanged call line is not read
  as new, so a rewritten test gets its control by hand.

- **Controls for INVALID tests.** Break the code by hand: swap a comparison, delete a branch, or
  return a constant. Confirm the test fails on its assertion, not on a crash or a timeout, then
  restore the code. Record it as a trailer in a commit message on the branch:
  `Control: <what you broke> -> <how the test failed>`, one per INVALID test. For a TypeScript
  test the check accepts any one trailer on the branch, so the reviewer is who holds you to the
  rest; a Rust test needs a trailer naming it, unless falsify killed it with a mutant of the
  change (`rust.md` § Tests). Never bypass a hook with `--no-verify`.

Two lessons from the scaffold's controls:

- **A test that fails only by timing out is weak.** Assert the thing you care about first, then
  wait, so a failure prints the value you expected.
- **A control can find a real bug.** One control caught a race where a fast-exiting process
  destroyed its tmux session before `remain-on-exit` applied.

`pnpm test:falsify --base <ref>` judges the branch against another base. On the host, a new test
that runs real tmux comes out INVALID, because its setup refuses; `pnpm test:real falsify` judges
it in the container. Hand-made mutants of such a test run there too. Stryker-style mutation
scores are not a gate, because their cost and equivalent mutants make the number meaningless.

## Hermeticity

A test owns everything it touches and leaves nothing behind.

- **The host.** Real tmux runs only in the container or CI (above). A global setup runs no build
  or compile step: a step that fails there makes vitest run teardown on a half-made setup.
- **Paths.** Medium and integration runs get a temporary `BAZHEN_HOME`. Unit runs point it at a
  path that doesn't exist. Never read or write the real Bazhen directories.
- **tmux.** A test runs tmux only through `@bazhen/host-guard`, which names every server by a
  socket path inside a directory the run owns, and refuses `default` and the directory the
  user's own servers share. Get a server with `testServer(label)`, so a leak says which test
  caused it, and kill it in `afterAll`. Each run also gets its own `TMUX_TMPDIR` and runs outside
  any tmux client (`TMUX` unset). Teardown fails the run on any server still alive.
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

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
| Test runs refuse to start when the machine is short of PTYs                        | integration, api and holder setup           |
| Holder tests use only their run's home, reach no tmux, and leave no holder running | holder setup and teardown                   |
| A signal is sent only from a chokepoint that checks its target                     | `pnpm check` (`scripts/check-standards.ts`) |
| A test that may signal processes it didn't start runs only in a sandbox            | `cargo-gate test-all`; `require_sandbox()`  |
| Suites never synthesise CPU load on a shared machine                               | review; `--cpus` quota on each container    |
| Every test runs under a memory and time cap                                        | `pnpm check`; vitest setup; cargo's runner  |
| Fakes over mocks; behaviour-named tests; no snapshots of terminal output           | review                                      |
| Behaviour tests are black-box: they reach the daemon only through public surfaces  | review                                      |

Rust tests follow this page too, with the differences in `rust.md` § Tests: nextest, proptest,
insta for protocol frames, cargo-fuzz for every function that takes bytes from outside, and
falsify judging new tests by mutating the change instead of reverting it, with a `Control:`
trailer naming each test it can't judge.

## Sizes

Size is about what a test touches, and the file name declares it. The sizes follow _Software
Engineering at Google_.

| Size   | File                               | May touch                            | Runs in                                |
| ------ | ---------------------------------- | ------------------------------------ | -------------------------------------- |
| small  | `src/**/x.test.ts`                 | memory only, including `app.request` | `pnpm test`, in parallel, milliseconds |
| small  | `scripts/*.test.ts`                | memory only                          | `pnpm test`                            |
| medium | `src/**/x.medium.test.ts`          | temporary files, SQLite              | `pnpm test:medium`                     |
| medium | `scripts/*.medium.test.ts`         | temporary files, git, subprocesses   | `pnpm test:medium`                     |
| medium | `tests/integration/*.test.ts`      | a private tmux server, real PTYs     | `pnpm test:real integration`           |
| medium | `tests/holder/*.test.ts`           | holders and real PTYs, no tmux       | `pnpm test:real holder`                |
| medium | `tests/holder/containment.test.ts` | holders in real systemd scopes       | CI's containment job only              |
| medium | `tests/cli/*.test.ts`              | the CLI as a process, a fake daemon  | `pnpm test:medium`                     |
| large  | `tests/api/*.test.ts`              | the daemon as a process, tmux, CLIs  | `pnpm test:real api`                   |
| large  | `tests/e2e/*.spec.ts`              | daemon, web client and browser       | `pnpm test:real e2e`                   |

`pnpm check` runs the small and medium tests on the host; none of them runs tmux or an agent, or
signals a process it didn't start. The holder tests and the Rust tests that start a holder, close a
child or sweep the ledger do signal such processes, as a closing holder signals its child's session,
so they run only on a disposable host: `pnpm test:real holder` and `pnpm test:real rust`, or CI. The
integration, api and e2e tests run real tmux, so they run only on a disposable host too: the test
container (`pnpm test:real`, which builds it from the worktree without mounting it) or a CI runner.
A disposable host carries a root-owned `/etc/bazhen-disposable-host`, and for real tmux is Linux;
their setup refuses to start anywhere else. Never create that file on a machine you work on. Inside
a container or CI they are the `pnpm test:integration`, `test:api` and `test:e2e` scripts, one
worker each. Each run's containers have no network and get a CPU quota of half the machine
(`BZ_TEST_CPUS` overrides it), because a suite that starts a busy process per core would otherwise
take every core from the agents working on the same machine. They run in `bazhen-tests.slice`, so
the slice's cap holds every run's containers together, and each gets a memory cap of half the
machine, with no swap beyond it (`BZ_TEST_MEMORY`, in GiB, overrides it), so a runaway dies in its
container. A probe container checks they land there first, which they do under rootless Podman,
or rootless Docker with the systemd cgroup driver, under a user systemd. Where they can't, as under
rootful Docker or Docker Desktop, the run refuses to start, except on a disposable host, which no
other run shares: there each container gets a quarter of the machine. A run removes its
containers, image and build context on every exit it sees, Ctrl-C, SIGTERM and SIGHUP included,
and gives each cleanup command 30 seconds; a second signal abandons the cleanup. What a run killed
outright or abandoned left, the next run on the same machine removes: it sweeps the stopped containers, images and contexts whose owning process is gone, and an
image only once no container uses it.
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
- `tests/cli` is the CLI's own, held to the same rule: it runs the `bazhen` binary `BAZHEN_CLI`
  names (without it, the release build `pnpm build:cli` makes) against a fake daemon on the socket
  the CLI looks for, and asserts what the CLI sent, printed and exited with. It needs no tmux, so it
  runs on the host, and it holds a CLI in any language to the same verbs.

## Falsification

Every new test must be shown to fail without the code it covers.

- **Revert check.** CI runs it on every pull request, and you run `pnpm test:falsify` before
  pushing. It takes the branch's new tests and runs them against the source as it was at the
  branch's merge base with main (origin/main when there is a remote), in a throwaway
  worktree (`scripts/falsify.ts`). The source is every file the branch changed under `apps/*/src`
  or `packages/*/src`, and its TypeScript under `scripts/`, tests aside. `scripts/falsify.ts`
  is reverted like any other script: the copy that runs is your checkout's, so only the tests
  see the base's. A script's committed output is reverted with it (`.oxlintrc.json` with
  `scripts/lint-config.ts`; the protocol's schema and fixtures with their sources), listed in
  `GENERATED` in `scripts/falsify.ts`. A branch that changes falsify, anything it imports, or how
  it is run is judged by the base's falsify too, in CI and in `pnpm test:real falsify`
  (`pnpm test:falsify:base`, `scripts/falsify-base.ts`, which runs only in a sandbox), so its new
  tests also need what that falsify asks for, usually a `Control:` line. Only committed work
  counts. Each test comes out as one of:
  - **KILLED** — it failed. Good.
  - **SURVIVED** — it passed without the change, so it can't detect the change. The check
    fails. Only a test that directly imports a reverted file, or runs one it names with
    `new URL("<file>", import.meta.url)`, can survive.
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
  rest. A Rust test falsify didn't kill with a mutant of the change needs a trailer of its own,
  whose subject starts with the test's full path as nextest lists it:
  `Control: <module::path::test_name>: <what you broke> -> <how the test failed>` (`rust.md`
  § Tests). Never bypass a hook with `--no-verify`.

Two lessons from the scaffold's controls:

- **A test that fails only by timing out is weak.** Assert the thing you care about first, then
  wait, so a failure prints the value you expected.
- **A control can find a real bug.** One control caught a race where a fast-exiting process
  destroyed its tmux session before `remain-on-exit` applied.

`pnpm test:falsify --base <ref>` judges the branch against another base. On the host, a new test
that runs real tmux comes out INVALID, because its setup refuses; `pnpm test:real falsify` judges
it in the container. Hand-made mutants of such a test run there too. The image carries
cargo-nextest and cargo-mutants at the versions `RUST_TOOLS` in `scripts/cargo-gate.ts` pins, and
fetches what the base's lockfiles name as well as HEAD's, so a branch touching the Rust workspace
is judged there with no network, the base's falsify included. When falsify can't install a
worktree's dependencies, it prints the end of what pnpm said.

Falsify reverts and mutates code that signals processes only in a sandbox, as
`scripts/signal-paths.ts` defines one. Outside it, a branch that would revert or mutate such code
(`isSignallingSource`), or run a test that signals (`isSignallingTest`), is refused before any of
its tests run. Falsify names the files and points at `pnpm test:real falsify`, and judges none of
the branch, since a partial verdict would read as a pass. Inside the sandbox it also runs the Rust
tests ignored as signalling, which a plain nextest run skips. Stryker-style mutation
scores are not a gate, because their cost and equivalent mutants make the number meaningless.

## Memory and time caps

A test that runs away with memory takes more than its own run. Past the machine's memory the
kernel's OOM killer picks a victim, and systemd may then stop the whole scope the victim lived in,
terminals and agents included. So every test runs under a memory cap and a time cap, in a cgroup
of its own, and a runaway dies alone.

- **Scripts.** A `package.json` step that starts tests runs as
  `node scripts/capped.ts --memory <n>G --time <n>m -- <command>`, its caps beside its command.
  `pnpm check` fails a step without one, or with a cap above 24 GiB or 120 min. Run anything else
  that runs tests by hand as `pnpm capped -- <command>` (8 GiB, 120 min): `cargo mutants`,
  `cargo test`, a one-off script.
- **Test binaries.** `.cargo/config.toml` makes `scripts/capped.ts --test-binary` cargo's target
  runner, so cargo test, nextest and cargo-mutants start every test process through it, a
  hand-typed `cargo mutants` included. Outside a capped run each test process gets a 4 GiB cap of
  its own. Inside one it runs as it is, held by that run's cap. Where systemd can't cap, the runner
  watches its test in a process group it started, since nextest gives each test a group of its own
  that a run's watchdog can't reach. cargo-mutants runs its tests with nextest
  (`.cargo/mutants.toml`), because rustdoc starts doctests without the runner.
- **vitest** refuses to start outside a capped run. Under systemd it reads that from the kernel,
  so setting the variable a watched run hands its children doesn't count.
- **How a run is capped.** Where a systemd user manager enforces caps (systemd 253 or later, with
  the memory controller delegated: a probe reads the caps back from inside a scope), each run is a
  scope in `bazhen-tests.slice`, with no swap. Past its cap the kernel kills only the scope's
  biggest process, and the run goes on to report it. A capped command inside a capped scope runs
  in that scope, under its cap. The slice holds all capped runs together to
  60% of the machine. Elsewhere (macOS, CI runners, containers) a watchdog sums the anonymous
  memory of the run's process tree, and past the cap kills the whole run. A run prints its peak,
  and the cap that fired, if one did: `capped: peak 1.2 GiB of 8 GiB`.
- **A cap is a ceiling, not a budget.** A script's cap is about twice its measured peak, and at
  least 4 GiB. A test that needs more than that is the bug, not the cap.
- **A control that tests a cap runs under one,** like any other test.

## Hermeticity

A test owns everything it touches and leaves nothing behind.

- **The host.** Real tmux runs only in the container or CI (above). A global setup runs no build
  or compile step: a step that fails there makes vitest run teardown on a half-made setup.
- **Paths.** Medium, integration and holder runs get a temporary `BAZHEN_HOME`. Unit runs point
  it at a path that doesn't exist. Never read or write the real Bazhen directories.
- **tmux.** A test runs tmux only through `@bazhen/host-guard`, which names every server by a
  socket path inside a directory the run owns, and refuses `default` and the directory the
  user's own servers share. Get a server with `testServer(label)`, so a leak says which test
  caused it, and kill it in `afterAll`. Each run also gets its own `TMUX_TMPDIR` and runs outside
  any tmux client (`TMUX` unset). Teardown fails the run on any server still alive.
- **Holders.** Holder tests run on a disposable host, under a temporary `BAZHEN_HOME` in `/tmp`, so
  the longest holder socket path fits the 103 bytes a Unix socket allows on macOS. Take paths from
  `tests/support/holder-home.ts`, whose `testHome()` and `holderSocket()` refuse any home but the
  run's. Close every holder a test starts in `afterAll`: teardown closes any still answering,
  through the protocol, and fails the run naming each. It counts a holder closed only once its pid
  is gone too, and otherwise keeps the home for whatever it ran. `tmux` on their `PATH` refuses to
  run, and teardown fails the run if anything appears in their `TMUX_TMPDIR`. A holder's child gets
  only its spec's environment: build it with `holderEnv()` or `holderProcessSpec()`, which put
  `HOME`, `XDG_*` and `TMUX_TMPDIR` in the run's home and the refusal first on `PATH`.
  `requireHolderEnv()` refuses any other, and any variable but those, terminal and locale settings
  and a test's own `BZ_TEST_*`. A holder test starts processes only through
  `tests/support/holder-spawn.ts`, which passes their env through it; lint bans `tests/holder`
  everything else that starts one: `child_process`, `node-pty`, `module`'s `createRequire`,
  `cluster` and `worker_threads`.
- **Signals.** A signal to a wrong pid ends someone else's work, and one to -1 every process the
  user owns. Raw signal calls (`process.kill`, `process._kill` or `process.abort` however it is
  reached: directly, by a default or namespace import or a re-export, through a constant bound to
  `process`, or computed, in code or in a template's `${…}`; a member
  named `kill` on anything, as text can't tell a `ChildProcess` or a node-pty terminal from
  another object; a `timeout`, `killSignal` or `signal` option to a `child_process` start, which
  Node enforces with a kill; Rust's `kill_process`,
  `kill_process_group`, `kill_current_process_group`, `pidfd_send_signal`, `libc::kill`,
  `libc::killpg`, `tgkill` and `tkill`, nix's `kill` and `killpg` by path, a `use` naming `libc`
  or a `signal` module that imports `kill`, a glob or a rename at any depth of its groups, any
  `pub use` of either, `sigqueue` and the kill syscalls), and a process started to
  send one (`kill`, `pkill`, `killall`, `killall5` or `skill` run directly, through a launcher
  such as `env`, `sudo` or `timeout`, or by a shell, `xargs kill`, `systemctl kill`, `loginctl
  terminate-user` and the like, and `fuser -k`), appear only in the chokepoints
  `scripts/signal-paths.ts` lists, and `pnpm check` names any other. For TypeScript that
  is `packages/host-guard/src/signal.ts`, which refuses 0, ±1, this process, its parent and its
  group before it sends, and signals itself only in `dieBy`, on purpose. A child this process
  spawned and still holds is signalled through its `signalOwnChild`, and an API whose `kill`
  sends no signal of its own is named for what it does (`TmuxServer.killServer`). Rust tests use the
  `bazhen-test-signal` crate, a dev-dependency only, which refuses the same and checks a holder's
  start time and command once a pidfd pins it. The holder itself sends only from
  `crates/bazhen-holder/src/guard.rs`, which holds each process by a pidfd (an exit watch on
  macOS) and refuses 0, ±1 and any number ≤ 1, the holder, its group, its session and its
  ancestors, a leader that isn't the holder's own unreaped child, and any process outside that
  leader's session. In a test build it also refuses to send off a disposable host (its
  `sandbox-tripwire` feature), and a test build of the holder refuses to start there, with exit
  code 9. The one process
  started to send a signal is `systemctl --user kill` of the cap's own scope
  (`packages/host-guard/src/cap.ts`). It and the kill Node sends a child it started on a
  start's timeout are allowed only at the calls `ALLOWED_SIGNALS` names, each with its reason and
  how many times it appears. Another signal in the same file still counts, and so does a copy of an
  allowed call, an entry whose call has gone, and any option but `timeout` at an allowed start. A
  file listed only for its fixtures, text that names kills and runs none, has every kill on a
  command line allowed, a real one included, so review is what keeps one out; any other signal in
  it still counts. The
  check is defence in depth: it reads text, so the
  chokepoints' own refusals are what stop a stray signal. On a command line it is a best-effort
  heuristic that fails closed where it reads one. It takes a literal's own escapes, then reads
  words as the shell does: a quoted or escaped part joins the text it touches (`k''ill` is
  `kill`), `$'…'` means what its escapes spell, and a backslash-newline continues the line. It
  reads as a command line too the text inside each quote and substitution, each word with a
  quoted part, and each here-string. A kill program counts wherever it follows a launcher,
  whatever that launcher's options, or `time` or `coproc`, or wherever an argument follows it,
  and so does a program word built by a substitution where the line names a kill. A `kill`
  passes only when, past at most one signal spec and a `--`, and less its redirections with
  their targets and any comment, each operand is `$$`, `$!` or a plain `$var`, never a
  substitution. A line naming a kill that leaves a substitution open counts. One that leaves a
  quote open, as a prose apostrophe does, counts if either reading of that quote is a kill. It
  accepts these gaps: a kill program held in a constant or a shell variable, or printed by a
  substitution whose line doesn't name it; a plain `$var` operand, whatever it holds; a launcher
  not on its list, or a kill program more than four arguments after one; operands `xargs`
  appends; `eval`, whose arguments join into a line the check never reads whole; process
  substitution, `<(…)`; an apostrophe in a heredoc body, which reads as a quote; a literal's
  `\x` and `\u` escapes; in TypeScript, `{ default as p }`, `Reflect.get`, `require` and dynamic
  imports of `process`; `require()` of `child_process`, a start renamed by destructuring
  (`const { spawn: s } = cp`) or re-exported, and a start's options built in a variable or
  spread rather than written at the call; `kill` destructured in a parameter (`({ kill }) =>`);
  node-pty's `destroy()`, which also signals its child by pid unless that terminal's `kill` was
  replaced first, as `apps/daemon/src/pty/node-pty.ts` does; a `/` read as division or a regular
  expression where only the syntax tree can tell; other unusual Rust `use` forms; and a method that signals by pid, which
  `deny.toml` keeps out only by banning the crates known so far to have one (`rust.md` § Signals).
  It fails closed on a module that is only named `signal`: a glob or rename of tokio's counts, so
  import its items by name. A Rust test that may signal processes it didn't start is
  `#[ignore = "signals processes; runs in pnpm test:real rust"]` and starts with
  `bazhen_test_signal::require_sandbox().unwrap();`, both of which `pnpm check` requires, so the
  host skips it and `pnpm test:rust:all` runs it only on a host carrying a root-owned
  `/etc/bazhen-disposable-host`: the test container or a CI runner. A PID namespace doesn't count:
  Flatpak terminals, devcontainers, LXD and WSL2 are workstations in one. A test of a guard asserts
  on what the guard returns, sends `SIGCONT`, or signals only a child it started, so a guard a
  mutant breaks still harms nothing.
- **PTYs are a machine-wide resource.** macOS has 511, and a leak starves every terminal on the
  machine. The setup refuses to run above 420 in use. A runtime change that opens PTYs needs a
  lifecycle test that repeats the operation and asserts the handle count returns to its baseline
  (`ptyHandleCount()`). Linux uses the same fraction of `/proc/sys/kernel/pty/max`;
  `BZ_PTY_CUTOFF` exists only for machines with a different PTY limit, never to get a leaky run
  through.
- **Ports.** Use free ports, never fixed ones, because parallel worktrees run the same suites.
- **CPU.** A test or probe never synthesises CPU load (busy loops, stress tools) on a shared
  machine, because every agent on it slows down with you. A comparison that needs load runs on a
  CI runner: rerun the pull request's CI job that runs the suite, for example `api`. The per-suite
  `--cpus` quota (`BZ_TEST_CPUS`) is a backstop, not permission.
- **Untracked files run.** `pnpm test:real` copies untracked, non-ignored files from the worktree
  into the image, so an uncommitted test file runs as part of the suite. Remove probes before you
  run it.

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
  predicates at module scope, and only `fc.assert` inside the test. Every run draws from one fixed
  seed (`tests/support/fast-check-seed.ts`), which every vitest project loads, so a failure on a
  pull request is the change's. The nightly `properties` job in `.github/workflows/fuzz.yml` draws
  new cases with a random `FC_SEED` it prints, and a red run names the commit and the command that
  replay it. A failure it finds comes back as a test of fast-check's counterexample.
- **Test HTTP routes through `app.request`,** with a `Host` header from the allowlist
  (`apps/daemon/src/http/app.test.ts`).
- **Migrations.** Each is a file in `apps/daemon/src/store/migrations/`, named `YYYY-MM-DD-slug`
  for the day it was written, and appended to `MIGRATIONS`. A database runs every migration it
  hasn't recorded, in list order, so one may build only on migrations that were on main when it
  was written; two written in parallel must not depend on each other, and when their appends
  conflict, keep both. A migration on main is never edited, renamed or removed. Its file imports
  only types and exports its migration frozen, so a later change elsewhere can't alter what it
  does. `pnpm check` holds those, against the merge base with main: each name is listed once, for
  its own file and that file's own frozen export; files on main are unchanged and keep their
  order; and the list starts with `NUMBERED_MIGRATIONS`, which never changes. A medium test runs
  each named migration after all the others, as a database that missed it would, and requires a
  fresh database's schema, so two that don't commute fail it. Nothing checks that a new migration
  has its own upgrade test. The formatter skips the directory, so a formatter upgrade can't
  rewrite a shipped migration. A new migration gets a medium test that opens a database at the
  migration before it and upgrades it.
- **No snapshots of terminal output.** Assert the specific bytes or screen content that matter.
- **Flaky tests are bugs.** There are no retries. Fix the race, or delete the test and record why.

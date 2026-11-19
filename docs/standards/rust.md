# Rust standards

Why the Rust rules exist. They add to `code.md` and `testing.md`, which apply to Rust as to
TypeScript wherever this page doesn't say otherwise. Where a check enforces a rule, its failure
says enough to fix the problem without this page. Read this page when a rule seems wrong, or when
a review asks for something no check covers.

| Rule                                                                                                                                    | Enforced by                                           |
| --------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Crates live only in `crates/<name>`, each taking the workspace lints                                                                    | `pnpm check` (`scripts/check-standards.ts`)           |
| Every target is built and tested from where Cargo looks by default; no build script or proc macro of ours                               | `pnpm check` (`scripts/check-standards.ts`)           |
| The lint levels, test allowances, `deny.toml` and the gate scripts are the ones below, with nothing beside them to loosen them          | `pnpm check` (`scripts/check-standards.ts`)           |
| Clippy's pedantic group and the restriction lints below fail the build                                                                  | `pnpm lint:rust` (`-D warnings`)                      |
| No named lint can be lowered by any attribute, however it is written                                                                    | the compiler (`forbid`)                               |
| No lint is suppressed in source, except `unsafe_code` in an unsafe module; no code comes from a file the scan doesn't read              | `pnpm check` (`scripts/check-standards.ts`)           |
| The gates run with no flag, alias, wrapper or runner from the caller                                                                    | `scripts/xtask.sh gate`, which every gate script runs |
| Code is formatted by rustfmt's defaults                                                                                                 | `pnpm format:check`                                   |
| No `unwrap`, `expect`, `panic!` or indexing that can panic outside tests; no `todo!`, `unimplemented!`, `unreachable!` or `dbg!` at all | `pnpm lint:rust`                                      |
| No `print!` or `eprint!`: stdout and stderr may be the protocol                                                                         | `pnpm lint:rust`                                      |
| Every `unsafe` block has a `SAFETY:` comment, one unsafe operation each                                                                 | `pnpm lint:rust`                                      |
| Dependencies are pinned exactly in `[workspace.dependencies]`, and members take them from there                                         | `pnpm check` (`scripts/check-standards.ts`)           |
| Dependencies have permitted licences, no advisory, one version each                                                                     | `pnpm deny`                                           |
| Tests run under nextest                                                                                                                 | `pnpm test:rust`                                      |
| Every new Rust test fails on a mutant of the change, or has a `Control:` trailer naming it                                              | CI on pull requests (`pnpm test:falsify`)             |
| Library errors are typed with thiserror; long-running processes log with tracing                                                        | review                                                |
| Every function that takes bytes from outside is fuzzed, or listed with why it is no decoder                                             | `pnpm check` (`scripts/check-standards.ts`)           |
| Rust components are certified black-box, by the TypeScript suites                                                                       | review                                                |
| Crates split by dependency weight and I/O boundary, not one per module                                                                  | review                                                |
| No crate builds an async runtime, HTTP stack or SQLite unless `HEAVY_ALLOWED` lists it                                                  | `pnpm check` (`scripts/check-standards.ts`)           |
| Rust signals only from the chokepoint for its role; an import that hides a `kill` counts as a raw call                                  | `pnpm check` (`scripts/signal-paths.ts`)              |
| No dependency that signals any pid through a method: the crates `deny.toml` bans (§ Signals)                                            | `pnpm deny`                                           |
| A command line is parsed by clap's builder API: long flags only, nothing inferred                                                       | review; the api suites                                |
| API message types are hand-written serde, held to the fixtures `packages/protocol` writes                                               | review                                                |
| Async code owns every task, cancels through one token tree and never blocks the runtime                                                 | review                                                |

## Layout

One Cargo workspace at the repository root: `Cargo.toml`, one `Cargo.lock` and one target
directory.
Every crate is a directory in `crates/`, named as its package is (`crates/bazhen-hook`). Each
member takes `edition`, `rust-version` and `publish` from `[workspace.package]`, so the edition
is 2024 everywhere and nothing is published by accident. The one other crate a crate may hold is
its fuzz crate, `crates/<name>/fuzz`, a workspace of its own because it builds on nightly
(§ Tests).

`rust-toolchain.toml` pins the compiler. rustup honours it on the host, in CI and in the test
container (`tests/real/Dockerfile`), so a lint that fires in CI fires locally too. Upgrading the
toolchain is a commit of its own: new lints arrive with it, and the commit fixes them.

Protocol types that more than one program speaks live in a crate of their own, not inside the
binary that first uses them, so every other speaker can depend on them directly.

## Crates

Split crates by dependency weight and I/O boundary, not one per module. Code gets a crate of its
own when:

- it takes a heavy dependency (an async runtime, an HTTP server, SQLite) that another program using
  its neighbours must not build;
- it separates logic from I/O, so the logic is tested with no socket, file or process;
- a second program uses it, as the CLI and the daemon both speak the API's messages;
- it is a boundary a check pins by path, as a signal chokepoint is.

Otherwise it is a module. Each crate costs a public API at its seam (`unreachable_pub` leaves no
half-way), with `# Errors` docs and a typed error; a manifest the checks read; a fuzz crate if it
decodes; the orphan rule between it and its neighbours; and link time under `lto` with one codegen
unit.

**What starts on every call stays light.** The CLI and the hook start on every call an agent
makes, and a crate they share with the daemon passes on whatever it takes. So no member builds a
crate in `HEAVY_CRATES` (tokio, hyper, axum, rusqlite and the like) unless `HEAVY_ALLOWED` in
`scripts/check-standards.ts` lists it, with why. `pnpm check` follows each member's dependencies,
but not its dev-dependencies, which only its tests build, through `Cargo.lock`, and names the chain
that reaches one. A member that depends on a listed one reaches what that one reaches, so it needs
an entry of its own: the daemon's crates go there, and the CLI never does.

The split this gives, with the TypeScript each takes over:

- a protocol crate: serde types for `packages/protocol`'s API messages, and no I/O. The holder's
  wire stays `bazhen-holder-proto`;
- a client crate, std only: HTTP/1.1 over the daemon's Unix socket, finding the socket, deadlines.
  It has no serde, so the hook, which forwards bytes it never parses, can share it;
- the CLI, a thin binary over those two;
- for the daemon: a pure core (`packages/core`), a store (SQLite), a host guard (signals, process
  identity and sandbox detection, as `packages/host-guard`), a crate per runtime, the harness
  adapters (one crate until their dependencies differ), and the daemon binary, which wires them
  together under tokio.

wezterm's `wezterm cli` and zellij's client are thin clients of a server over a Unix socket, and
atuin splits its client, server, shared types and daemon the same way.

## API Guidelines

Follow the [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/checklist.html). The
crates are not published, but they are read by agents that know the guidelines, and a crate that
follows them is cheap to split out later. Microsoft's
[Pragmatic Rust Guidelines](https://microsoft.github.io/rust-guidelines) are a second reference
where those are silent; where either differs from this page, this page holds. The items reviews
check most:

- **Naming** (C-CASE, C-CONV, C-GETTER): `as_`, `to_` and `into_` say what a conversion costs;
  getters have no `get_` prefix.
- **Common traits** (C-COMMON-TRAITS, C-DEBUG): public types derive `Debug`, and `Clone`,
  `PartialEq`, `Eq` and `Default` where they make sense. `missing_debug_implementations` is
  denied, because a type that can't be printed makes every test failure that holds it opaque.
- **Errors** (C-GOOD-ERR): error types implement `std::error::Error` and `Display`, and are
  meaningful to a caller, never `()` or `String`.
- **Documentation** (C-FAILURE): a public function says when it errors (`# Errors`) and panics
  (`# Panics`). Pedantic's `missing_errors_doc` and `missing_panics_doc` hold it to that.
- **Type safety** (C-NEWTYPE, C-CUSTOM-TYPE): a terminal id, an offset or a size is a newtype or
  an enum, not a bare `u64` or `bool` argument.

## Lints

`[workspace.lints]` in `Cargo.toml` holds every lint level, and every crate inherits it with
`[lints] workspace = true`. Clippy's `pedantic` group is denied, and `pnpm lint:rust` runs clippy
with `-D warnings`, so any finding fails. Every lint named on its own below is `forbid`, not
`deny`: no `#[allow]` or `#[expect]` can lower a forbidden lint, whether it is written out, built
by a macro or brought in by `include!`, so the compiler itself refuses the suppression (E0453).
Of rustc's own lints, `unsafe_code` is denied (§ Unsafe), and these are forbidden:

- `unsafe_op_in_unsafe_fn`: an `unsafe fn`'s body is not one big unsafe block, so each unsafe
  call in it still gets its own block and proof;
- `missing_debug_implementations` (§ API Guidelines);
- `unreachable_pub`: in a binary, or in a module its crate doesn't export, `pub` claims an API
  that doesn't exist; `pub(crate)` says what is true;
- `rust_2018_idioms`: no elided lifetimes in paths, no `extern crate`.

On top of pedantic:

- `unwrap_used`, `expect_used` and `panic`: a panic in a process that holds terminals takes them
  down with it. Product code returns an error, or handles the case. `clippy.toml` allows all
  three in `#[test]` functions and `#[cfg(test)]` items, where a panic is how a test fails; a
  helper in a crate's `tests/` directory outside those returns a `Result` instead.
- `indexing_slicing` and `string_slice`: `x[i]` and `&s[a..b]` panic on input the code didn't
  expect, and in a decoder that input is whatever the peer sent. Use `get`, `split_at_checked`
  or a pattern, and handle the `None`. `clippy.toml` allows indexing in tests.
- `print_stdout` and `print_stderr`: a program's stdout may be its protocol, as the hook's is,
  so output goes through an explicit writer, and diagnostics through `tracing`.
- `todo`, `unimplemented`, `unreachable` and `dbg_macro`: unfinished code doesn't merge, and an
  `unreachable!()` is a panic the types didn't rule out.
- `allow_attributes` and `allow_attributes_without_reason`: when the workspace's allow-list
  doesn't cover a case, the fix is in the code. AGENTS.md's rule holds: a failing check is fixed
  in the code, never by a suppression.

**The groups are guarded by the scan, not by forbid.** A forbidden group (`pedantic`,
`rust_2018_idioms`) only warns when an attribute lowers one of its lints, which `-D warnings`
doesn't catch, and the derives of crates such as serde and thiserror emit allows that rustc means
to make errors under one. So the groups stay `deny`, and `scripts/check-standards.ts` is what
keeps their lints, `unsafe_code` and rustc's default lints from being suppressed. It reads Rust
source with comments and strings set aside, and fails on:

- any attribute that allows or expects a lint, at any depth (`cfg_attr` included), but an unsafe
  module's own `#![expect(unsafe_code, reason = "...")]`;
- any `#` that doesn't begin an attribute written out in full, and any attribute holding a macro
  variable: a macro could otherwise build a suppression from tokens no scan reads;
- `include!`, however it is reached, and `#[path]`: each brings in code from somewhere the scan
  doesn't read;
- `macro_rules!` outside a module listed in `MACRO_MODULES`: clippy doesn't lint inside a
  macro's expansion, so a macro of ours wrapping `.unwrap()` hides it from `unwrap_used`. A module
  joins the list once a review has read its macros;
- `#[ignore]` and `#[should_panic]`, which skip a test or pass it when it fails, and any
  attribute naming `clippy` (`#[clippy::msrv]`), which changes how it lints. The one `#[ignore]`
  allowed is `#[ignore = "signals processes; runs in pnpm test:real rust"]`, exactly, on a test that
  may signal processes it didn't start, and only on one whose body starts with
  `bazhen_test_signal::require_sandbox().unwrap();`: the host skips it, and `pnpm test:rust:all`
  runs it on a disposable host (`testing.md` § Hermeticity);
- a `cfg` or `cfg_attr` predicate other than those in `CFG_ALLOWED` (`test` alone today), or
  `not` around one: code compiled only in a release build, on another OS, under a feature or
  outside tests is code the gates never build, so no lint or test reads it. A predicate joins
  the list with why the gates build it: a `target_os` joins only with a CI job in the same pull
  request that runs `pnpm lint:rust` and `pnpm test:rust` on that OS, as the PTY holder's
  `linux` and `macos` code will need (CI's `rust-macos` job runs them on macOS);
- a test harness of a member's own (`harness = false`), which could run nothing.

The targets themselves are read from Cargo, not from the manifests' text, so no spelling of a
manifest can say one thing to the check and another to Cargo. `cargo metadata` must report every
crate in `crates/` as a member of the workspace, and every target of each a library, binary,
test, bench or example, at the place Cargo looks for it by default, run by the tests and needing
no feature, with a target for every file at such a place. A build script (`build.rs`, or a
`build` key) or a proc macro of ours fails, as does a build dependency: a build script can hand
the compiler flags and environment no gate sees. Every dependency is an exact version or a crate
of ours in `crates/`.

**When a dependency's macro trips a forbidden lint.** An attribute or derive macro from another
crate that emits an allow of a forbidden lint fails with E0453. `#[tokio::main]` and
`#[tokio::test]` allow `clippy::expect_used`; clap's derive allows the whole `clippy::restriction`
group, which fails once for every forbidden lint in it. Use the crate's macro-free form instead:
clap's builder API, and a runtime built with `tokio::runtime::Builder` in `main` and in a test
helper. Only when a crate has none, lower the one lint it trips to `deny` in `Cargo.toml` and in
`WORKSPACE_LINTS`, in a commit that names the macro; the scan still guards it. Try a new macro
under the workspace lints before taking its crate on.

**The configuration is pinned too.** `scripts/check-standards.ts` holds `[workspace.lints]`, the
root manifest's other tables, `rust-toolchain.toml`, `clippy.toml` and `deny.toml` as
`WORKSPACE_LINTS`, `ROOT_TABLES`, `TOOLCHAIN_CONFIG`, `CLIPPY_CONFIG` and `DENY_CONFIG`, and the
gate scripts in `package.json` as `RUST_GATE_SCRIPTS`, and the root `.cargo/config.toml` (the
capping test runner, which caps what `cargo run` and `cargo bench` start too) and `.cargo/mutants.toml` as `CARGO_CONFIG` and `MUTANTS_CONFIG`, and fails
when the files differ, so a lint level, the toolchain or a gate changes only in a commit that
changes the script and this page with it. The root manifest holds no other table (a patch, an
excluded crate, another profile), and a workspace dependency is an exact version or a path to
`crates/<name>`. It also fails on anything that would loosen them from beside: cargo config in any
other `.cargo` directory, whose `rustflags` can turn lints off; a second `clippy.toml` or
`deny.toml`; a nextest config, whose profiles can filter tests out; a `rustfmt.toml`; a second
toolchain file; a crate outside `crates/`; Rust source outside a crate there; and any file but those
in `RUST_FLAG_EXEMPT` that names a flag or variable able to switch lints off (`RUSTFLAGS`,
`--cap-lints`, a rustc wrapper, a cargo alias).

**The gates run in a clean environment.** `--cap-lints allow` switches every lint off, forbidden
ones included, whether it arrives through `RUSTFLAGS`, a cargo config in any parent directory, or an
argument, and a cargo alias can replace `cargo clippy` with a command that passes. So each gate
script runs `scripts/xtask.sh gate`, which runs `cargo xtask gate` (`crates/bazhen-xtask/src/gate.rs`)
and fails unless xtask itself ran and handed back the nonce it was given: a runner set for the
host's target triple outranks the one the alias names, and could stand in for xtask and pass. xtask
holds the gate's command, calls the subcommand's own binary (`cargo-clippy`, not `cargo clippy`), refuses any option after the gate (`pnpm test:rust
<name>` may name tests), removes the variables that change flags, tools or the test runner, sets
`CARGO_ENCODED_RUSTFLAGS` empty (which outranks every other source of rustflags), and overrides any
configured compiler or wrapper. A cargo config outside the repository may still set what the gate
can't override: a test runner, a `rustdoc` or a linker, `[env]` (which can hand clippy its flags), a
profile (which can turn off overflow checks and debug assertions in the tests) or an `include` of
another file. The lint and test gates refuse to run under one. A global `RUSTFLAGS` or a wrapper
such as sccache is ignored by the gates, not an error. xtask's own build overrides a wrapper or
compiler a cargo config names; one in the caller's environment (`RUSTC`, `RUSTC_WRAPPER`,
`RUSTC_WORKSPACE_WRAPPER`) outranks that and still builds it, which only a deliberate one would
misuse.

**Every fd is close-on-exec.** `clippy.toml` disallows the rustix calls that make an fd without
`O_CLOEXEC` (`rustix::fs::open`, `rustix::fs::openat`, `rustix::io::dup`): a child would inherit
it, and the PTY holder takes any fd without the flag for one it inherited, and closes it. std's
`OpenOptions` and `try_clone` set the flag; a crate that turns on another rustix module that makes
fds (`pipe`, `net`) adds its flag-less calls to the list in the same commit.

**The allow-list** is in `[workspace.lints.clippy]` only, one line each, with its reason beside
it. It holds `must_use_candidate`, which fires on nearly every pure function; `#[must_use]` goes
where ignoring the value is a bug. A lint joins the list only once it has fired on real code, its
fix made the code worse, and the commit says so. A lint with a threshold is tuned in `clippy.toml`
rather than allowed: `max-struct-bools = 4` lets a wire message (an agent) hold the four booleans
its protocol defines, and still flags a fifth.

## Formatting

rustfmt with its defaults: no `rustfmt.toml`. `pnpm format` applies it, `pnpm format:check`
checks it, and the pre-commit hook formats staged `.rs` files. Defaults mean no style is ever
up for discussion in a review.

## Unsafe

`unsafe_code` is denied everywhere. A crate that needs FFI, as one that opens PTYs and manages
process groups does, keeps all of its `unsafe` in **one named module**, and that module:

- is listed in `UNSAFE_MODULES` in `scripts/check-standards.ts`, with why it needs `unsafe`;
- sets `#![expect(unsafe_code, reason = "...")]`, the only suppression the check accepts, and
  only in a listed file; put it first in the module, where a reader looks for it;
- is not a crate root and declares no child module, inline or in a file, so the `expect` covers
  that one file; tests of its safe API go in its parent module;
- exposes a safe API, so no caller writes `unsafe`;
- has a `// SAFETY:` comment on every `unsafe` block, saying which invariant makes it sound
  (`undocumented_unsafe_blocks`), and one unsafe operation per block
  (`multiple_unsafe_ops_per_block`), so each proof covers exactly one call.

A workspace `forbid` can't be relaxed for one module, which is why the lint is `deny` and the
check makes it a forbid everywhere else. Prefer a safe crate (`rustix`, `nix`) over writing the
FFI by hand; the module then shrinks to what no such crate covers.

## Errors

- **Libraries define typed errors with `thiserror`.** One error enum per seam, with the fields a
  caller needs to decide what to do, as `code.md` § Errors asks of TypeScript. Wrap a lower
  error with `#[source]` or `#[from]`, so the cause stays inspectable.
- **Binaries may collect errors at the top**, in `main`, into one exit path. Not `anyhow` in a
  library: it erases the type a caller would match on.
- **Never swallow an error.** `let _ =` or `.ok()` on a `Result` is allowed only where the
  failure is really harmless, with a comment saying why. A crate whose whole contract is to fail
  silently says so once, at its top, instead of at every call: the hook's crate doc says that on
  any failure it exits 0 with no output, so the harness carries on as it would without Bazhen.
- **Decoders return errors, never panic, on any input.** Bytes from a socket are input.

## Logging

Long-running processes log with `tracing`: structured fields (`terminal_id = %id`), not
formatted strings, and spans around each connection or terminal. Never `println!` or `eprintln!`
for diagnostics: stdout and stderr may be the protocol. A short-lived client such as the hook,
whose output the harness reads, logs nothing.

## Signals

`testing.md` § Hermeticity holds the rule and what the scan reads. In Rust, a signal goes through
the chokepoint for its role, which each failure of `pnpm check` names:

- the holder's: `crates/bazhen-holder/src/guard.rs`;
- tests': the `bazhen-test-signal` crate, a dev-dependency only;
- everything else's: the `bazhen-host-guard` crate. The first code outside the holder that signals a
  process it didn't start creates it, and lists it in `SIGNAL_CHOKEPOINTS` in
  `scripts/signal-paths.ts`. It checks what `packages/host-guard/src/signal.ts` checks: never 0,
  ±1 or any pid ≤ 1, never itself, its parent, its ancestors or its own group, and a holder only
  once its command and start time match.

The host-guard crate's file joins `PRODUCT_CHOKEPOINTS` in `scripts/check-standards.ts` too, which
`pnpm check` requires of every Rust chokepoint outside the tests' crate: its product code is
exempt, and its own tests send through `bazhen-test-signal` like any others. A caller names it as
`bazhen_host_guard`, which `RUST_SENDERS` in `scripts/signal-paths.ts` reads, so falsify changes a
caller only in a sandbox.

`Child::kill`, std's or tokio's, needs no chokepoint on a child the code started, while that child
is unreaped and is reaped only through that `Child`: until then its pid can't be reused. A `use`
that names `libc` or a `signal` module and imports `kill`, a glob or a rename, at any depth of its
groups, counts as a raw call, since it hides the `kill` the scan reads for. So does any
`pub use` of either, which would let another file import one through a path of ours. The crates
known so far whose methods signal any pid, or hold one to signal (`sysinfo`, `psutil`, `heim`,
`kill_tree`, `pidfd`), are banned in `deny.toml`: a method call is text the scan can't tell from a child's own `kill`.

A chokepoint's product code is exempt only where it calls a raw function by its path. One it
imports, or takes as a value (a `const` holding it, say), fails, since the file's tests reach that
name through `super::` with nothing in sight the scan reads; a syscall number counts as called
only as `syscall`'s first argument. Its tests take no glob `use` and name no bare `kill`, a method's
`.kill()` aside, so they reach nothing the product code imports. And no manifest takes `libc` or
`nix` under another name (`package = "libc"`), which the scan, reading their kills by the crate's
name, wouldn't read; a `package` it can't read as a plain string fails too.

## Command-line programs

A program agents run, as the `bazhen` CLI is, starts on every call, and the agents' permission
rules match its command line. So:

- **Parse with clap's builder API** (`clap::Command` and `Arg`), with default features off and
  `std`, `help`, `usage` and `error-context` on. Not clap's derive, which no crate here can compile
  (§ Lints), and not a parser of our own: each verb declares its options once, so its usage and
  what it refuses can't drift from what it parses. lexopt is the fallback if clap's output can't
  be made to fit. It is smaller, but every usage line and per-verb check is then written by hand.
  Either costs about a tenth of a millisecond a call.
- **Every spelling is exact.** Long flags only: no `short`, `alias` or `visible_alias`, and none of
  the `infer_*` settings, which accept a prefix (`--tit` for `--title`). clap adds `-h`, `--help`,
  `-V` and `--version` unless told not to (`disable_help_flag`, `disable_version_flag`), so a CLI
  turns off the short forms always, and the long ones if the CLI it replaces didn't accept them.
  A permission rule that matches `--brief-file` must see `--brief-file`. clap's defaults already
  refuse a prefix and a positional that starts with `-`, and accept `--opt=value`, options among
  positionals, and a global option after the verb.
- **Exit codes are one enum,** each a contract a caller branches on: 0 done, 1 failed, 2 usage,
  3 the daemon isn't running.
- **stdout is the answer and stderr the diagnostics,** each through an explicit writer. Output is
  plain lines a model reads, with no colour and nothing that changes when stdout isn't a terminal.
  A closed stdout (a pipe into `head`) ends the program quietly, not with an error.
- **No async runtime and no daemon dependency** (§ Crates). A call is one blocking exchange over
  the socket.

The TypeScript api suites are the CLI's gate (§ Tests, Black-box first): they hold its verbs,
output and exit codes, so they keep certifying them whatever the CLI is written in. Where jj, uv
and ruff snapshot a CLI's output, those suites do it here.

## Protocol types

The daemon's API is defined by the zod schemas in `packages/protocol`, and `pnpm schema` writes
their JSON Schema to `packages/protocol/schema/`. While the daemon is TypeScript, a Rust crate that
speaks the API holds hand-written serde types for the messages it uses. They are held to the
TypeScript by fixtures `pnpm schema` writes for each of those messages, as it writes the holder's
for `crates/bazhen-holder-proto/tests/fixtures.rs`: the crate decodes each fixture and encodes it
back to equal JSON. An object zod doesn't make strict accepts fields it doesn't know, so only a
strict one gets `#[serde(deny_unknown_fields)]`, and a field with a default may be missing.

`pnpm schema` also writes `crates/bazhen-protocol/src/id.rs`, the `PROTOCOL_ID` the Rust crates
speak: the hash of `packages/protocol/schema/` that `protocolId()` gives. `pnpm schema --check` holds
it to the schema, and a test in `crates/bazhen` hashes the schema itself, so neither side drifts.
The CLI compares it with the daemon's `protocolId`, and calls one that differs another build.

The types aren't generated from the JSON Schema. typify, tried on every schema, fails on the event
and agent-reference unions, names each nested type by where it sits because the schemas inline
them, and writes `#![allow]`s the scan refuses. Once the daemon is Rust, the direction turns: the
Rust types are the source, and the schema and the web's types are generated from them, as Oxide's
dropshot and progenitor do.

## Async and the daemon

Only code that serves many connections at once is async, and only the daemon's crates take an
async runtime (§ Crates). A crate the CLI or the hook shares stays blocking.

- **tokio, multi-threaded, built in `main`** with `tokio::runtime::Builder`, and in tests by a
  helper (§ Lints says why not its macros).
- **Every task has an owner.** A `TaskTracker` or a `JoinSet` holds each spawned task, and
  shutdown waits for them: a task nothing awaits loses its error. Once tokio is a dependency,
  `clippy.toml` disallows `tokio::spawn` and `tokio::task::spawn`, so a spawn goes through one.
- **Cancellation is one tree.** One `CancellationToken` from shutdown, a child per connection,
  terminal and agent, and every loop selects on its own. A `select!` branch holds only a
  cancel-safe future; one that isn't (a read into a buffer it owns) runs in a task of its own.
- **Every external wait has a deadline,** as the hook's do: `tokio::time::timeout` around a
  socket, a child or a peer.
- **Nothing blocks the runtime.** SQLite, file reads and anything else that blocks run on a thread
  of their own or in `spawn_blocking`, and no std lock is held across an `.await` (clippy's
  `await_holding_lock`).
- **HTTP:** axum on hyper, on a tokio `UnixListener` for the socket and a TCP listener for the
  web. Every route has a body limit, the protocol's error shape is made in one place, and
  WebSockets go through axum's.
- **SQLite:** rusqlite with SQLite bundled, so the version is the lockfile's, not the host's. WAL,
  `STRICT` tables, and a database file of mode 0600. One thread owns the connection that writes;
  readers open their own. Migrations are a named set the database records as applied.
- **Logging:** § Logging, with a span per connection, terminal and agent, and no token, device
  secret or brief in a field.

## Dependencies

- **Pin exactly in `[workspace.dependencies]`** (`proptest = { version = "=1.12.0" }`) and take
  it in a member with `{ workspace = true }`, so one version serves the whole workspace; a crate
  of ours goes there as a `path`. The standards check fails on anything else. Disable default
  features you don't use. Upgrade one foundational crate per commit: one most of a crate's code
  is written against, such as serde, the async runtime or the PTY crate, whose upgrade can change
  behaviour everywhere at once.
- **`pnpm deny`** runs cargo-deny with `deny.toml`. It fails on a licence outside the allow-list
  (dev-dependencies included), an advisory or a yanked crate, two versions of one crate, a
  wildcard version, or a source other than crates.io. It reads the dependency tree for the
  triples Bazhen is built for, Linux and macOS on x86_64 and aarch64 (`[graph] targets`): a
  crate only Windows builds, such as alacritty_terminal's `windows-sys`, is neither checked nor a
  second version. A new licence joins the allow-list in the commit that needs it, naming the
  crate: Unicode-3.0 is there for `unicode-ident`, which `serde_derive` and `thiserror-impl`
  build on. A crate that brings a second version of one already in the tree (`syn`, say) aligns
  the versions rather than relaxing `multiple-versions`.
- **An advisory fails `pnpm check` on every branch the day it is published,** main included,
  with no code change. That is deliberate: the fix is to upgrade the crate, or, when the advisory
  can't reach our use of it, to list its id in `deny.toml`'s `[advisories] ignore` with the
  reason.
- **Prefer the standard library** in a binary on a hot path. The hook is std only: it runs on
  every tool call, and its build needs no network.

## Tests

`testing.md` holds for Rust: sizes, hermeticity, behaviour names, fakes over mocks, no sleeps.
What differs:

- **Run with nextest** (`pnpm test:rust`), which runs each test in its own process, so one
  test's panic or leaked state can't reach another. nextest doesn't run doctests, so an example in
  a doc comment is documentation, not a test; the first library crate with one adds
  `cargo test --doc` to `test:rust`. Unit tests sit in a `#[cfg(test)] mod tests`
  at the bottom of the file they test; tests of a crate's public API go in its `tests/`.
- **Property tests with proptest** for every decoder and state machine: a round trip through
  the encoder, and the decoder's answer for every malformed input, such as every truncation
  (`crates/bazhen-hook/src/lib.rs`, `mod properties`).
  - **A pull request tests the change, not the draw.** `cargo xtask gate`, and `gateEnv` in `scripts/rust-gate.ts`, fix
    `PROPTEST_RNG_SEED` for every gate and for falsify, and drops `PROPTEST_CASES`, so each
    `proptest!` block runs the case count its code gives (proptest's 256 where it gives none). A
    run sees the cases the last one saw, so a property that fails on a pull request failed
    because of what changed. Changing the seed changes every property's cases at once: do it on
    purpose, never to get past a failure.
  - **New cases are drawn nightly**, by the `properties` job in `.github/workflows/fuzz.yml`,
    round after round on random seeds that it prints. A red run fails with the commit and the
    command that replay it, and GitHub emails it to whoever last edited the job's `cron` line.
    No issue is filed. A failure comes back with its fix as a named test of the shrunk case, plus
    the `cc` line proptest wrote, committed to the crate's `proptest-regressions/<file>.txt`.
    proptest replays every line in that file for every property in the source file, before its
    own cases. Don't commit a line a mutant produced.
- **Snapshots with insta, for protocol frames only.** An encoder's output is a contract other
  languages read, so a reviewed snapshot of it is the right assertion. insta joins
  `[workspace.dependencies]` with the first crate that needs it. A protocol whose source is a
  TypeScript schema is pinned instead by the fixtures that source writes, which the crate must
  match frame by frame: `crates/bazhen-holder-proto/tests/fixtures.rs` reads
  `packages/protocol/fixtures/holder/`. This is the one exception
  to `testing.md`'s "no snapshots of terminal output": screen contents are still asserted byte by
  byte.
- **A cargo-fuzz target for every decoder.** Bytes a peer sends are whatever it sends, so every
  function in a crate's `src` directory that takes bytes from outside, whatever its name or
  visibility, is taken for a decoder. It takes them by a parameter (a byte slice or buffer, a reader
  of any kind, stdin, a child's output, a WebSocket), or by reading them in its body
  (`.read(&mut buf)`, `std::fs::read`, `rustix::io::read`, `recv`, a `BufReader`,
  `io::stdin().lock()`, a closure's read included). A socket, a file or an fd in a signature isn't bytes: holding one is not
  reading it, so a function that only binds, borrows or sets one up needs no entry. A struct or enum
  of the same crate that carries bytes (a byte field, a parameter bounded by a byte trait, or a
  field of such a type; an enum by its variants' fields, not their names), or one of another
  crate that this crate brings in (by a `use` or a path, through the crate, a module of it, an
  alias for either or another crate's re-export, the crate under its package name or a name a
  manifest gives it), is a byte type too: a function taking one
  is a decoder, as is a method of it taking `self` that can reach the bytes, as a stateful frame
  reader reads through `self`. A method reaches them when its body uses a field holding them
  (`self.buf`, `let b = &self.buf;`, a closure or a helper given it), uses `self` other than by a
  field (handed on, matched, destructured), calls a method of its own that reaches them, or calls
  one with no body in the file. One that only reads the type's other fields, as a getter of an id
  does, isn't a decoder. Every method taking `self` counts when no field pins the bytes: on an enum,
  a struct whose bytes come by a type parameter bounded by a byte trait (`struct R<T: Read>`), and
  in an impl bounded by one (`impl<R: Read> Reader<R>`). A method taking another value of its own
  type (`other: &Self`) is a decoder too. A byte field `pub` to other crates fails unless it is
  listed in `PUBLIC_BYTE_FIELDS` with why its bytes aren't from outside: another crate reads it
  where the rule doesn't look. So does a struct, or an enum's variant, whose fields the rule can't
  split, since it can't tell which hold bytes. A variant's fields are public wherever its enum is,
  so a function whose pattern binds a field of a variant holding bytes takes them, however it got
  the value: a match arm, an or-pattern, a guard, `if let`, `let … else` (typed too), `matches!`,
  a `for`, a closure's parameter, a `select!` arm, a destructuring assignment, nested in a tuple,
  slice or `Some(…)`, with generic arguments (`Msg::<T>::Raw`), or a value holding the variant
  whole by `r @ Reply::Data { .. }` or `r @ Some(Reply::Data { .. })`. One that matches with
  `{ .. }` or binds only other fields doesn't, nor does one that builds the variant, compares it
  in a guard, indexes by it or hands it on: the function it is handed to takes the enum in its
  signature.
  `scripts/check-standards.ts` fails until each is listed in `FUZZED_DECODERS` with the fuzz target
  that calls it, or in `NOT_DECODERS` with why it isn't one: an encoder, a function that reads bytes
  only to hand them to a fuzzed decoder, one reached only through a fuzzed decoder. A module
  compiled only under test (`#[cfg(test)] mod name;`, and the modules inside it) isn't read. A
  method is listed with its type (`lib.rs::Reader::next_frame`). A stale entry, an entry with no
  reason, a type alias of a byte type and a `use … as` renaming one fail too (`as _`, which brings a
  trait's methods into scope, is fine), as does a `use` bringing in a variant that carries bytes by
  its own name (`use Reply::*`), which a pattern could then name bare, and a manifest whose
  `package` name isn't a plain string, since the rule couldn't tell which crate it names.
  - **Text is not taken for bytes**, because most functions taking `&str` parse text the program
    made itself. A decoder of a text protocol whose input doesn't pass through a fuzzed byte
    decoder first is listed in `FUZZED_DECODERS` by hand, with its own target, and review checks
    for it: `pane_title::body` takes the pane id tmux passes as an argument, so
    `crates/bazhen-hook/fuzz/fuzz_targets/pane_title.rs` drives it.
  - **The rule is a reviewer's net, not a proof.** It reads signatures and the names of reads in a
    body, so it can't see a function a macro generates, a read through a wrapper whose method isn't
    named as a read (a `next_message()`), or a trait's default method reading through a method the
    trait requires (`fn kind(&self) -> u8 { self.raw()[0] }`). A read is a method given something
    to read into, so a channel's `recv()`, an iterator's `peek()` and `OpenOptions::read(true)`
    aren't reads, and neither is a bare call to a function of the same file, which is read where it
    is defined. It finds a pattern on a byte variant by the enum's name, so it can't see one written
    through an alias of the enum the rule fails anyway, a qualified path (`<Msg>::Raw(b)`), or a
    macro of the crate's own that takes the pattern apart. And a type parameter with no bound
    (`enum E<T> { Data(T) }`, `struct S<T> { b: T }`) carries bytes only where it is used as
    `E<Vec<u8>>`, so the type isn't a carrier: a function taking `E<Vec<u8>>` is found by its
    signature, but one that matches a value it got by a call isn't. Review checks those by hand. Two looser edges are known, and review covers them too: a
    target that names a type and calls `.decode(` on a value counts as driving that type's `decode`,
    so the reviewer checks the value is of the listed type; and a method that only measures or
    clears a byte field (`self.buf.len()`, `self.buf.clear()`) uses it, so it counts as a decoder
    and needs a `NOT_DECODERS` entry with its reason. That is expected, not noise.
  - The targets live in `crates/<name>/fuzz/fuzz_targets/<target>.rs` (cargo-fuzz's layout),
    with seed inputs in `fuzz/seeds/<target>/`. The fuzz crate is a workspace of its own, its
    dependencies pinned exactly. A target asserts what must hold of every input, not only
    that nothing panics: `crates/bazhen-hook/fuzz/fuzz_targets/parse_reply.rs` checks that a
    reply `parse_reply` accepts is one the reader saw end where it does.
  - A crate with a decoder needs a library target, because a fuzz crate can call only a
    library. The decoder is `pub` there; the binary, if any, is a `main` that calls the
    library, as `crates/bazhen-hook/src/main.rs` is.
  - `.github/workflows/fuzz.yml` runs every target nightly, and for a minute on a pull request that
    changes the Rust. Its `fuzz` job alone builds on nightly, pinned there as `NIGHTLY`, because
    libFuzzer's instrumentation needs it; everything else builds on the pinned toolchain. Its
    `properties` job runs the property tests (above), not the targets. To run a target locally,
    install that nightly and `cargo install --locked cargo-fuzz@0.13.2` once, then run
    `pnpm capped -- cargo +nightly-2026-11-01 fuzz run <target> -- -rss_limit_mb=2048
    -max_total_time=600` from the crate's directory. cargo-fuzz starts its target without cargo's
    test runner, so the cap and libFuzzer's own limits are given by hand.
- **Falsify judges Rust tests by mutating the change, not by reverting it.** A Rust unit test
  lives in the file it tests, so reverting the source would revert the test, and a test of a new
  function wouldn't compile without it. When a branch touches `crates/` or the Cargo files,
  `pnpm test:falsify` has nextest list the tests at the base and at HEAD, so it finds every new
  test however it is declared (`#[test]`, proptest, a macro of the crate's own). It then has
  cargo-mutants list the mutants of the code the branch changed, and runs the new tests against
  them, one mutant at a time, in a throwaway worktree. A test that passes unmutated, fails
  twice under one mutant by panicking in test code, and passes again once the mutant is undone,
  is KILLED, and the mutant is printed beside it as its control. In test code means every place
  the failure names is an item under a bare `#[cfg(test)]`, or a file in the crate's `tests/`,
  and isn't a line that calls a product `#[track_caller]` function: the test's assertion, or an
  `unwrap` in it, but not a crash, a timeout, a panic in product code, the standard library or a
  dependency, or a failure on state an earlier run left. Keep test modules at the top level of
  the file, as rustfmt lays them out: falsify ends a test item at the next line that starts at
  column 0. The run stops once every new test is killed, and after at most 100 mutants. Any
  other new test is INVALID: one that fails unmutated, one no mutant killed, or one a branch with
  no Rust source change can't be mutated for. It needs a `Control:` trailer of its own naming it
  by the full path nextest lists, after you break the code by hand and watch it fail on its
  assertion:
  `Control: pane_title::tests::refuses_a_window_id: accept @ ids -> left: Some, right: None`.
  One trailer may name several tests it covers. Each test process runs under the cargo runner's
  memory cap (`testing.md` § Memory and time caps), and a mutant whose run had one killed there is
  listed INVALID with that reason, as one that ran out of time is. Install cargo-mutants once:
  `cargo install --locked cargo-mutants@27.1.0`; the `pnpm test:real` image carries it, and
  cargo-nextest, at the versions `crates/bazhen-xtask/rust-tools.json` pins.

**Black-box first.** A Rust component is certified by the TypeScript suites that drive it from
outside, as `testing.md` § Black-box behaviour tests describes: `tests/api` delivers mail to
real harness CLIs through the hook, and a program that holds terminals gets a contract suite that
drives it over its socket. Rust's own tests pin the internals; a behaviour a user or the daemon
can observe gets its test in those suites, so they keep certifying it if the other side is
rewritten.

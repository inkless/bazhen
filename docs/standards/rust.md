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
| The gates run with no flag, alias, wrapper or runner from the caller                                                                    | `scripts/cargo-gate.ts`, which every gate script runs |
| Code is formatted by rustfmt's defaults                                                                                                 | `pnpm format:check`                                   |
| No `unwrap`, `expect`, `panic!` or indexing that can panic outside tests; no `todo!`, `unimplemented!`, `unreachable!` or `dbg!` at all | `pnpm lint:rust`                                      |
| No `print!` or `eprint!`: stdout and stderr may be the protocol                                                                         | `pnpm lint:rust`                                      |
| Every `unsafe` block has a `SAFETY:` comment, one unsafe operation each                                                                 | `pnpm lint:rust`                                      |
| Dependencies are pinned exactly in `[workspace.dependencies]`, and members take them from there                                         | `pnpm check` (`scripts/check-standards.ts`)           |
| Dependencies have permitted licences, no advisory, one version each                                                                     | `pnpm deny`                                           |
| Tests run under nextest                                                                                                                 | `pnpm test:rust`                                      |
| Every new Rust test has a `Control:` trailer naming it                                                                                  | CI on pull requests (`pnpm test:falsify`)             |
| Library errors are typed with thiserror; long-running processes log with tracing                                                        | review                                                |
| Every decoder of a framed binary protocol has a cargo-fuzz target                                                                       | review                                                |
| Rust components are certified black-box, by the TypeScript suites                                                                       | review                                                |

## Layout

One Cargo workspace at the repository root: `Cargo.toml`, one `Cargo.lock` and one target
directory.
Every crate is a directory in `crates/`, named as its package is (`crates/bazhen-hook`). Each
member takes `edition`, `rust-version` and `publish` from `[workspace.package]`, so the edition
is 2024 everywhere and nothing is published by accident.

`rust-toolchain.toml` pins the compiler. rustup honours it on the host, in CI and in the test
container (`tests/real/Dockerfile`), so a lint that fires in CI fires locally too. Upgrading the
toolchain is a commit of its own: new lints arrive with it, and the commit fixes them.

Protocol types that more than one program speaks live in a crate of their own, not inside the
binary that first uses them, so every other speaker can depend on them directly.

## API Guidelines

Follow the [Rust API Guidelines](https://rust-lang.github.io/api-guidelines/checklist.html). The
crates are not published, but they are read by agents that know the guidelines, and a crate that
follows them is cheap to split out later. The items reviews check most:

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
  attribute naming `clippy` (`#[clippy::msrv]`), which changes how it lints;
- a `cfg` or `cfg_attr` predicate other than those in `CFG_ALLOWED` (`test` alone today), or
  `not` around one: code compiled only in a release build, on another OS, under a feature or
  outside tests is code the gates never build, so no lint or test reads it. A predicate joins
  the list with why the gates build it: a `target_os` joins only with a CI job in the same pull
  request that runs `pnpm lint:rust` and `pnpm test:rust` on that OS, as the PTY holder's
  `linux` and `macos` code will need;
- a test harness of a member's own (`harness = false`), which could run nothing.

The targets themselves are read from Cargo, not from the manifests' text, so no spelling of a
manifest can say one thing to the check and another to Cargo. `cargo metadata` must report every
crate in `crates/` as a member of the workspace, and every target of each a library, binary,
test, bench or example, at the place Cargo looks for it by default, run by the tests and needing
no feature, with a target for every file at such a place. A build script (`build.rs`, or a
`build` key) or a proc macro of ours fails, as does a build dependency: a build script can hand
the compiler flags and environment no gate sees. Every dependency is an exact version or a crate
of ours in `crates/`.

**When a dependency's macro trips a forbidden lint.** An attribute macro from another crate that
emits an allow of a forbidden lint (`#[tokio::main]` allows `clippy::expect_used`) fails with
E0453. Lower that one lint to `deny` in `Cargo.toml` and in `WORKSPACE_LINTS`, in a commit that
names the macro; the scan still guards it.

**The configuration is pinned too.** `scripts/check-standards.ts` holds `[workspace.lints]`, the
root manifest's other tables, `rust-toolchain.toml`, `clippy.toml` and `deny.toml` as
`WORKSPACE_LINTS`, `ROOT_TABLES`, `TOOLCHAIN_CONFIG`, `CLIPPY_CONFIG` and `DENY_CONFIG`, and the
gate scripts in `package.json` as `RUST_GATE_SCRIPTS`, and fails when the files differ, so a lint
level, the toolchain or a gate changes only in a commit that changes the script and this page with
it. The root manifest holds no other table (a patch, an excluded crate, another profile), and a
workspace dependency is an exact version or a path to `crates/<name>`. It also fails on anything
that would loosen them from beside: cargo config in a `.cargo` directory, whose `rustflags` can turn
lints off; a second `clippy.toml` or `deny.toml`; a nextest config, whose profiles can filter tests
out; a `rustfmt.toml`; a second toolchain file; a crate outside `crates/`; Rust source outside a
crate there; and any file but those in `RUST_FLAG_EXEMPT` that names a flag or variable able to
switch lints off (`RUSTFLAGS`, `--cap-lints`, a rustc wrapper, a cargo alias).

**The gates run in a clean environment.** `--cap-lints allow` switches every lint off, forbidden
ones included, whether it arrives through `RUSTFLAGS`, a cargo config in any parent directory, or an
argument, and a cargo alias can replace `cargo clippy` with a command that passes. So each gate
script runs `scripts/cargo-gate.ts`, which holds the gate's command, calls the subcommand's own
binary (`cargo-clippy`, not `cargo clippy`), refuses any option after the gate (`pnpm test:rust
<name>` may name tests), removes the variables that change flags, tools or the test runner, sets
`CARGO_ENCODED_RUSTFLAGS` empty (which outranks every other source of rustflags), and overrides any
configured compiler or wrapper. A cargo config outside the repository may still set what the gate
can't override: a test runner, a `rustdoc` or a linker, `[env]` (which can hand clippy its flags), a
profile (which can turn off overflow checks and debug assertions in the tests) or an `include` of
another file. The lint and test gates refuse to run under one. A global `RUSTFLAGS` or a wrapper
such as sccache is ignored by the gates, not an error.

**The allow-list** is in `[workspace.lints.clippy]` only, one line each, with its reason beside
it. It holds `must_use_candidate`, which fires on nearly every pure function; `#[must_use]` goes
where ignoring the value is a bug. A lint joins the list only once it has fired on real code, its
fix made the code worse, and the commit says so.

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

## Dependencies

- **Pin exactly in `[workspace.dependencies]`** (`proptest = { version = "=1.12.0" }`) and take
  it in a member with `{ workspace = true }`, so one version serves the whole workspace; a crate
  of ours goes there as a `path`. The standards check fails on anything else. Disable default
  features you don't use. Upgrade one foundational crate per commit: one most of a crate's code
  is written against, such as serde, the async runtime or the PTY crate, whose upgrade can change
  behaviour everywhere at once.
- **`pnpm deny`** runs cargo-deny with `deny.toml`. It fails on a licence outside the allow-list
  (dev-dependencies included), an advisory or a yanked crate, two versions of one crate, a
  wildcard version, or a source other than crates.io. A new licence joins the allow-list in the
  commit that needs it, naming the crate. The first crate to take `thiserror` or `tracing` meets
  both limits: they bring `unicode-ident`, under Unicode-3.0, and may bring a second version of a
  crate already in the tree (`syn`, say). Add the licence with that reason, and align the versions
  rather than relaxing `multiple-versions`.
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
  (`crates/bazhen-hook/src/main.rs`, `mod properties`). Don't commit a `proptest-regressions`
  file a mutant produced.
- **Snapshots with insta, for protocol frames only.** An encoder's output is a contract other
  languages read, so a reviewed snapshot of it is the right assertion. insta joins
  `[workspace.dependencies]` with the first crate that needs it. This is the one exception
  to `testing.md`'s "no snapshots of terminal output": screen contents are still asserted byte by
  byte.
- **A cargo-fuzz target for every decoder of a framed binary protocol.** No crate here has one
  yet, so the rule starts with the first that does, the holder protocol's crate, which adds the
  target and the CI job that runs it on a schedule (`cargo +nightly fuzz run <target>` for a fixed
  time). That job alone uses nightly, because libFuzzer's instrumentation needs it; everything
  else builds on the pinned toolchain. The hook's reply parser reads HTTP from the daemon's own
  socket, and its property tests cover it.
- **Falsify can't judge Rust tests by reverting.** A Rust unit test lives in the file it tests, so
  reverting the source would revert the test. When a branch touches `crates/` or the Cargo files,
  `pnpm test:falsify` has nextest list the tests at the base and at HEAD, so it finds every new
  test however it is declared (`#[test]`, proptest, a macro of the crate's own), and lists each as
  INVALID without running it. Each needs a `Control:` trailer of its own that names it by the
  full path nextest lists (`testing.md` § Falsification), after you break the code by hand and
  watch the test fail on its assertion:
  `Control: pane_title::tests::refuses_a_window_id: accept @ ids -> left: Some, right: None`.
  One trailer may name several tests it covers.

**Black-box first.** A Rust component is certified by the TypeScript suites that drive it from
outside, as `testing.md` § Black-box behaviour tests describes: `tests/api` delivers mail to
real harness CLIs through the hook, and a program that holds terminals gets a contract suite that
drives it over its socket. Rust's own tests pin the internals; a behaviour a user or the daemon
can observe gets its test in those suites, so they keep certifying it if the other side is
rewritten.

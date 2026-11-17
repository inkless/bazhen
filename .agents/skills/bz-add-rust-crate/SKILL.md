---
name: bz-add-rust-crate
description: Adds a crate to Bazhen's Cargo workspace (crates/*) that passes every Rust gate, deciding first whether it should be a crate at all. Use when changing Bazhen's source in this repository to add a library or binary crate, or to split code out of one. Not for adding a test (bz-write-rust-test), not for TypeScript packages, and not for operating a running Bazhen.
---

# Add a Rust crate to Bazhen

**Gate: a crate exists for a reason `docs/standards/rust.md` § Crates names.** A heavy
dependency another program must not build, logic split from I/O, a second program using it, or a
boundary a check pins by path. Anything else is a module in an existing crate.

## Steps

1. **Decide it is a crate**, by § Crates. Write the reason down; it goes in the commit message.
2. **Make the directory `crates/<name>/`,** named as the package (`bazhen-<what>`). Its
   `Cargo.toml` takes the workspace's package keys and lints, and nothing else at the top:

   ```toml
   [package]
   name = "bazhen-<what>"
   version = "0.1.0"
   edition.workspace = true
   rust-version.workspace = true
   publish.workspace = true
   [dependencies]
   thiserror = { workspace = true }
   [lints]
   workspace = true
   ```

3. **Record it in `Cargo.lock`:** `cargo update --workspace` adds the new member, and any new
   dependency, without moving another version. It is called directly because no pnpm script
   writes the lockfile: the gates build with `--locked`, so until then each fails with "cannot
   update the lock file".
4. **Take dependencies from `[workspace.dependencies]`.** A new third-party one goes there, pinned
   exactly (`=1.2.3`) with default features off (§ Dependencies). Run `pnpm deny`: a new licence
   or a second version of a crate is fixed now, not later. The new crate itself joins that table,
   as a `path` in name order, in the commit where another member first takes it: an entry no
   member uses draws a cargo warning on every gate.
5. **Lay the targets out where Cargo looks:** `crates/<name>/src/lib.rs`,
   `crates/<name>/src/main.rs`, `crates/<name>/tests/`. A crate whose code takes bytes from
   outside is a library with a thin `main` (§ Tests), so its fuzz crate can call it.
6. **Give each decoder its fuzz target,** in `crates/<name>/fuzz/` with seeds, and list it in
   `FUZZED_DECODERS` in `scripts/check-standards.ts`; list what only looks like one in
   `NOT_DECODERS` with why, and a byte field `pub` to other crates in `PUBLIC_BYTE_FIELDS` with
   why its bytes aren't from outside. Copy `crates/bazhen-hook/fuzz/`.
7. **List what the checks pin by path:** an FFI module in `UNSAFE_MODULES` (§ Unsafe); a crate that
   may build an async runtime, an HTTP stack or SQLite in `HEAVY_ALLOWED`, with why; a signal
   chokepoint in `SIGNAL_CHOKEPOINTS` in `scripts/signal-paths.ts`, in `PRODUCT_CHOKEPOINTS` in
   `scripts/check-standards.ts`, and its crate's name in `RUST_SENDERS` (§ Signals). Each entry
   says why in one line.
8. **Write its first test before its code** (bz-write-rust-test).
9. **Run the gates:** `pnpm check`, `pnpm lint:rust`, `pnpm test:rust`, `pnpm deny` and
   `pnpm format:check`. Fix each failure in the code.

## Checklist

- [ ] The commit says which reason in § Crates the crate exists for.
- [ ] `Cargo.toml` takes the workspace keys and `[lints] workspace = true`, and every dependency
      comes from `[workspace.dependencies]`.
- [ ] Each decoder has a fuzz target, or a `NOT_DECODERS` entry saying why it isn't one.
- [ ] A crate the CLI or the hook builds reaches nothing in `HEAVY_CRATES`.
- [ ] Every gate above passes.

## Gotchas

- **No `build.rs`, proc macro or build dependency of ours.** `pnpm check` refuses each: a build
  script can hand the compiler flags no gate sees.
- **No `#[cfg]` beyond `test`, and no features to turn code on.** Code only some build compiles is
  code no gate reads (§ Lints). A `target_os` comes with a CI job running the gates on that OS.
- **A dependency's macro can fail to compile under the forbidden lints** (E0453), as clap's derive
  and `#[tokio::main]` do. Use its macro-free form (§ Lints); never lower the workspace lints to
  fit it.
- **`pub` in a binary or a private module is refused** (`unreachable_pub`). A crate's API is what
  its `lib.rs` exports; the rest is `pub(crate)`.
- **A new crate that depends on one in `HEAVY_ALLOWED` needs an entry of its own,** since it
  reaches what that one reaches. If it is a crate the CLI builds, the dependency is wrong.

## Rationalizations

| Thought                                      | Answer                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------- |
| "Small crates are cleaner"                   | Each one costs a public API, a manifest and link time. Split for a reason |
| "I'll pin the dependency loosely for now"    | The check refuses it, and the lockfile can't hold two versions anyway     |
| "The CLI only needs one helper from there"   | Then the helper moves to a crate the CLI may build                        |
| "It's one `#[allow]` for a dependency macro" | The scan refuses it. Use the macro-free API                               |

# Bazhen

A local daemon that owns durable terminals on a private tmux server, plus a web client. TypeScript
throughout: pnpm workspaces, Node 26 (24 supported), oxlint, oxfmt, Vitest, Playwright.

## Tooling you might not expect

- The daemon runs `.ts` directly through Node's type stripping, so use erasable TypeScript only:
  no enums, namespaces or parameter properties. Import with the `.ts` extension
- Call `pnpm` scripts, not the tool binaries; the scripts carry the flags the checks rely on
- `BAZHEN_HOME` relocates all daemon state, and `BAZHEN_TMUX_SOCKET` names the private tmux server

## Rules no check enforces

- Never run `tmux` without `-L <socket>`, and never touch the user's default server or the
  `bazhen` socket. Tests use `testSocket()` from `tests/integration/helpers.ts`
- A failing check is fixed in the code, never by a suppression comment, a lowered severity or
  `--no-verify`. If the check is wrong, change the check, and say why in the commit
- `packages/core` is the domain: no I/O, and expected failures as typed errors
- `packages/protocol` changes stay additive within `/v1`: add optional fields, never rename or
  remove. Bump the `PROTOCOL_VERSION` minor in the same commit
- `apps/daemon/src/store/migrations.ts` is append-only. Never edit a shipped migration
- In `packages/runtime-tmux`, a setting that must apply before the process can exit (like
  `remain-on-exit`) goes in the same tmux command list as `new-session`
- A new test that the falsify harness reports INVALID needs a
  `Control: <what you broke> -> <how the test failed>` trailer in the commit message
- Commit subjects are Conventional Commits: `type(scope): subject`
- With parallel agents: stage files by name, never `git add -A`; don't use `git stash`;
  rebase, don't merge

## Standards

Why each rule exists, and the checklist to review against: `docs/standards/code.md`,
`docs/standards/testing.md`, `docs/standards/review.md`.

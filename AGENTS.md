# Bazhen

A local daemon that owns durable terminals on a private tmux server, plus a web client.
TypeScript throughout, in a pnpm workspace.

## Rules

- Never run `tmux` without `-L <socket>`, and never touch the user's default server or the
  `bazhen` socket. Tests use `testSocket()` from `tests/integration/helpers.ts`
- A failing check is fixed in the code, never by a suppression comment, a lowered severity or
  `--no-verify`. If the check itself is wrong, change the check, and say why in the commit
- Call `pnpm` scripts, not the tool binaries; the scripts carry the flags the checks rely on
- With parallel agents: stage files by name, never `git add -A`; don't use `git stash`;
  rebase, don't merge

## Standards

Why the rules and checks exist, and the checklist to review against: `docs/standards/code.md`,
`docs/standards/testing.md`, `docs/standards/review.md`.

# Bazhen

A local daemon that owns durable terminals on a private tmux server, plus a web client.
TypeScript in a pnpm workspace, and Rust in a Cargo workspace (`crates/`).

## Rules

- A failing check is fixed in the code, never by a suppression comment, a lowered severity or
  `--no-verify`. If the check itself is wrong, change the check, and say why in the commit
- Call `pnpm` scripts, not the tool binaries; the scripts carry the flags the checks rely on
- Tests that run real tmux (integration, api, e2e, and falsify of them) run only through
  `pnpm test:real`, in a throwaway container, never on the host: one wrong socket there ends
  every tmux session on the machine. They refuse to start anywhere else
- Holder tests (`pnpm test:holder`) run real PTYs and `bazhen-holder` processes on the host.
  They create everything under a temporary `BAZHEN_HOME`, and never point at a real one
- With parallel agents: stage files by name, never `git add -A`; don't use `git stash`;
  rebase, don't merge

## Standards

Why the rules and checks exist, and the checklist to review against: `docs/standards/code.md`,
`docs/standards/testing.md`, `docs/standards/review.md`; for web UI, `docs/standards/ui.md`; for
Rust, `docs/standards/rust.md`.

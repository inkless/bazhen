# Bazhen

Local-first environment for operating a fleet of 20+ concurrent development agents, with native
coordinator, workstream-lead, and worker roles and fully interactive terminals.

Early foundation: a local daemon that owns durable terminals on a private tmux server, and a web
client. Agents, tasks, and orchestration come later.

## Requirements

- Node.js 24 or newer (development uses 26.13.0; see `.nvmrc` / `.tool-versions`)
- pnpm 12 (pinned through `packageManager`)
- tmux 3.x
- macOS or Linux
- For the tests that run real tmux, Docker (`pnpm test:real`)

## Commands

| Command                          | Does                                                                                    |
| -------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Install exactly what the lockfile records, and the git hooks (husky)                    |
| `pnpm dev`                       | Start the daemon (`http://127.0.0.1:7900`) and the web client (`http://127.0.0.1:5173`) |
| `pnpm check`                     | Standards check, lint, format check, type-check, small and medium tests                 |
| `pnpm test`                      | Small tests                                                                             |
| `pnpm test:real [suite…]`        | The tests that run real tmux, in a throwaway Linux container: integration, api, e2e     |
| `pnpm test:falsify`              | Run the branch's new tests against the base's source; CI runs it on pull requests       |
| `pnpm build`                     | Compile packages to `dist/` and build the web bundle                                    |
| `pnpm format`                    | Rewrite files with oxfmt                                                                |

Contributing, for people and agents: [AGENTS.md](AGENTS.md) and [docs/standards/](docs/standards/).

## Layout

- `apps/daemon` — the service: configuration and paths, HTTP API, SQLite store, PTY seam
- `apps/web` — React + Vite client
- `packages/protocol` — shared types, schemas, and the protocol version
- `packages/core` — domain model and state machines; no platform imports
- `packages/runtime-tmux` — the tmux runtime adapter
- `tests/integration` — tests against a private tmux server (container or CI only)
- `tests/e2e` — Playwright browser tests

## Where Bazhen keeps data

macOS and Linux both follow XDG (`~/.config/bazhen`, `~/.local/share/bazhen`, …). The socket
lives in `$XDG_RUNTIME_DIR/bazhen` on Linux and `$TMPDIR/bazhen` on macOS, mode 0700.
`BAZHEN_HOME` relocates everything under one directory and gives it its own tmux server;
`BAZHEN_BANK` relocates only the document bank. `BAZHEN_PORT` overrides the daemon's port.
`BAZHEN_CLAUDE_PERMISSION_MODE` starts every Claude Code agent in that permission mode instead of
the one your settings pick.

Bazhen only ever manages its own tmux server, by the socket `tmux.sock` in its runtime directory
(`tmux -S`), never your default one or any server found by name.

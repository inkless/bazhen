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

## Commands

| Command                               | Does                                                                                    |
| ------------------------------------- | --------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`      | Install exactly what the lockfile records                                               |
| `pnpm dev`                            | Start the daemon (`http://127.0.0.1:7900`) and the web client (`http://127.0.0.1:5173`) |
| `pnpm check`                          | Standards check, lint, format check, type-check, small, medium and integration tests    |
| `pnpm test` / `pnpm test:integration` | Small tests / tests against a throwaway private tmux server                             |
| `pnpm test:e2e`                       | Browser tests: starts daemon and web client in a temporary `BAZHEN_HOME`                |
| `pnpm build`                          | Compile packages to `dist/` and build the web bundle                                    |
| `pnpm format`                         | Rewrite files with oxfmt                                                                |

Contributing, for people and agents: [AGENTS.md](AGENTS.md) and [docs/standards/](docs/standards/).

## Layout

- `apps/daemon` — the service: configuration and paths, HTTP API, SQLite store, PTY seam
- `apps/web` — React + Vite client
- `packages/protocol` — shared types, schemas, and the protocol version
- `packages/core` — domain model and state machines; no platform imports
- `packages/runtime-tmux` — the tmux runtime adapter
- `tests/integration` — tests against a private tmux server
- `tests/e2e` — Playwright browser tests

## Where Bazhen keeps data

Linux follows XDG (`~/.config/bazhen`, `~/.local/share/bazhen`, …); macOS uses
`~/Library/Application Support/Bazhen` and its siblings. `BAZHEN_HOME` relocates everything under
one directory; `BAZHEN_BANK` relocates only the document bank. `BAZHEN_PORT` and
`BAZHEN_TMUX_SOCKET` override the daemon's port and private tmux server name.

Bazhen only ever manages its own tmux server (`tmux -L bazhen`), never your default one.

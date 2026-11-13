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

| Command                          | Does                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Install exactly what the lockfile records, and the git hooks (husky)                                                |
| `pnpm dev`                       | Start the daemon (`http://127.0.0.1:7900`) and the web client (`http://127.0.0.1:7901`); no vite keyboard shortcuts |
| `pnpm bazhen <verb>`             | The CLI: `start`, `stop`, `status`, `doctor`                                                                        |
| `pnpm check`                     | Standards check, lint, format check, type-check, small and medium tests                                             |
| `pnpm test`                      | Small tests                                                                                                         |
| `pnpm test:real [suite…]`        | The tests that run real tmux, in a throwaway Linux container: integration, api, e2e                                 |
| `pnpm test:falsify`              | Run the branch's new tests against the base's source; CI runs it on pull requests                                   |
| `pnpm build`                     | Compile packages to `dist/` and build the web bundle                                                                |
| `pnpm format`                    | Rewrite files with oxfmt                                                                                            |

Contributing, for people and agents: [AGENTS.md](AGENTS.md) and [docs/standards/](docs/standards/).

## Layout

- `apps/daemon` — the service: configuration and paths, HTTP API, SQLite store, PTY seam
- `apps/cli` — the `bazhen` command, a client of the daemon's Unix socket
- `apps/hook` — `bazhen-hook`, the hook client harnesses run (Rust, standard library only)
- `apps/web` — React + Vite client, with React Aria Components for its widgets (`docs/standards/ui.md`)
- `packages/protocol` — shared types, schemas, and the protocol version
- `packages/core` — domain model and state machines; no platform imports
- `packages/runtime-tmux` — the tmux runtime adapter
- `tests/integration` — tests against a private tmux server (container or CI only)
- `tests/e2e` — Playwright browser tests

## Configuration

`~/.config/bazhen/config.toml` (or `<BAZHEN_HOME>/config/config.toml`). An unknown key or a wrong
value stops the daemon with a message naming the file and the key; `bazhen doctor` shows what it
runs with.

```toml
[daemon]
port = 7900 # or BAZHEN_PORT

[bank]
path = "/abs/path" # or BAZHEN_BANK

[agents]
shell = "direct" # or "login" (BAZHEN_AGENTS_SHELL)

[agents.env]
deny = ["MY_SESSION_*"] # never give agents these: names, or prefixes ending in *
passthrough = ["ITERM_PROFILE"] # give agents these, though Bazhen would strip them

[web]
external_origins = [
  "https://bazhen.example.com",
] # or BAZHEN_EXTERNAL_ORIGINS, comma-separated; see below
```

Agents get the environment a new terminal tab would, minus Bazhen's, tmux's, harnesses' session
and terminal-presentation variables. By default it is captured once, when `bazhen start` runs.

With `agents.shell = "login"`, each agent starts through your login shell (`$SHELL -l -i`, which
must be an absolute path), so your rc files run again at every launch, like a new tab. Be aware:

- Your rc can export variables Bazhen strips, and they reach the agent.
- An rc that prompts, or that starts tmux when `$TMUX` is empty (`[ -z "$TMUX" ] && exec tmux`),
  stops the agent from launching. Every agent has `BAZHEN_AGENT_ID` set before your rc runs, so
  guard such lines on it, for example `[ -z "$TMUX" ] && [ -z "$BAZHEN_AGENT_ID" ] && exec tmux`
  (fish: `set -q BAZHEN_AGENT_ID`).

### Reaching Bazhen from another device

Bazhen listens on `127.0.0.1` only and never terminates TLS. To open it from a phone, bring your
own route to that port that runs on this machine, such as a local reverse proxy: a proxy on
another host can't reach a loopback port. [docs/caddy.md](docs/caddy.md) sets up Caddy, with
your own domain or without one. Point it at the web dev server,
`http://127.0.0.1:7901`, while you run `pnpm dev`, and list the address it presents, exactly as
the browser shows it (scheme, host and any port), in `BAZHEN_EXTERNAL_ORIGINS`:
`BAZHEN_EXTERNAL_ORIGINS=https://bazhen.example.com pnpm dev`. The daemon and the dev server then
accept that address, and refuse every other non-loopback one; the daemon logs it at start, and
`bazhen doctor` lists it. The dev server reads only the variable; `web.external_origins` sets it
for the daemon alone. Plain `http://` to another host is refused unless
`web.allow_insecure_origins = true` (or `BAZHEN_ALLOW_INSECURE_ORIGINS=true`), since anyone on the
network could read the traffic.

Device pairing is not built yet, and nothing else authenticates a request. The Origin check
stops only a browser page on another site: a request with no Origin, as curl or any script
sends, passes it, so whatever reaches the route can type into your agents' terminals and run any
command as you. Until pairing, the route's own access control (the tunnel's login, a proxy's
access list) is the only protection. Keep it on a network only you use, behind that login, and
never on the public internet.

## The inbox

Everything an agent needs you for collects in the inbox, and each item offers only what can be
done about it now:

- **Approvals** (a tool call asking to run): Allow or Deny, while the harness is still waiting.
  Answering in the agent's terminal instead closes the item.
- **Questions**: a Claude Code `AskUserQuestion` is answered in the terminal; the inbox links to
  it. A Codex question (`request_user_input`) can be answered from the inbox when it is a single
  question and not a secret. Codex 0.166 lets an agent ask one only in **Plan mode** (switched
  in its TUI), or with `[features] default_mode_request_user_input = true` in your Codex config,
  an under-development setting; otherwise Codex refuses the question before it reaches Bazhen.
  MCP servers' elicitations and permission requests are answered in the terminal.
- **Failed turns**, **mail that couldn't be delivered**, and what an agent raises: Reply (sent to
  the agent as a message), Send the message again, or Dismiss.

## Where Bazhen keeps data

macOS and Linux both follow XDG (`~/.config/bazhen`, `~/.local/share/bazhen`, …). The socket
lives in `$XDG_RUNTIME_DIR/bazhen` on Linux and `$TMPDIR/bazhen` on macOS, mode 0700.
`BAZHEN_HOME` relocates everything under one directory and gives it its own tmux server;
`BAZHEN_BANK` relocates only the document bank. `BAZHEN_PORT` overrides the daemon's port.
`BAZHEN_CLAUDE_PERMISSION_MODE` starts every Claude Code agent in that permission mode instead of
the one your settings pick.

Bazhen only ever manages its own tmux server, by the socket `tmux.sock` in its runtime directory
(`tmux -S`), never your default one or any server found by name. To look at it yourself:
`tmux -S "$TMPDIR/bazhen/tmux.sock" ls` on macOS, `tmux -S "$XDG_RUNTIME_DIR/bazhen/tmux.sock" ls`
on Linux, or `<BAZHEN_HOME>/run/tmux.sock` under a relocated home. A runtime directory whose
socket path would be too long moves to `/tmp/bazhen-<uid>-<hash>`.

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

| Command                          | Does                                                                                                                    |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | Install exactly what the lockfile records, and the git hooks (husky)                                                    |
| `pnpm dev`                       | Start the daemon (`http://127.0.0.1:7900`) and the web dev server (`http://127.0.0.1:7901`); no vite keyboard shortcuts |
| `pnpm bazhen <verb>`             | The CLI: `start`, `stop`, `status`, `doctor`, `env refresh`, `pair`, `devices [revoke <id>]`                            |
| `pnpm check`                     | Standards check, lint, format check, type-check, small and medium tests                                                 |
| `pnpm test`                      | Small tests                                                                                                             |
| `pnpm test:real [suite…]`        | The tests that run real tmux, in a throwaway Linux container: integration, api, e2e                                     |
| `pnpm test:falsify`              | Run the branch's new tests against the base's source; CI runs it on pull requests                                       |
| `pnpm build`                     | Compile packages to `dist/` and build the web bundle, which the daemon serves at `http://127.0.0.1:7900`                |
| `pnpm format`                    | Rewrite files with oxfmt                                                                                                |

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
pairing = "auto" # or "always" (BAZHEN_PAIRING); see below

[notifications]
desktop = true # show what needs you on this machine's desktop while no dashboard is in sight
```

Desktop notifications go through `notify-send` on Linux, and on macOS through Bazhen's own
notifier app, which `pnpm build:notify` builds with Xcode's command-line tools (restart the
daemon after). The first notification asks for permission for "Bazhen"; clicking one opens the
inbox. `bazhen doctor` says when the app isn't built.

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
your own domain or without one. Build the web app (`pnpm build`), point the route at the daemon,
`http://127.0.0.1:7900`, which serves the built app as well as the API, and list the address it
presents, exactly as the browser shows it (scheme, host and any port), in
`BAZHEN_EXTERNAL_ORIGINS` or `web.external_origins`:
`BAZHEN_EXTERNAL_ORIGINS=https://bazhen.example.com pnpm bazhen start`. The daemon then accepts that
address, and refuses every other non-loopback one; it logs it at start, and `bazhen doctor`
lists it. Build again after you pull: the daemon serves whatever was built last, from the next
page load on. Never point a route at the web dev server (`pnpm dev`, port 7901): it serves the
repository's source. It refuses a request with another Host, another page's Origin, or a proxy's
forwarding header, but a forwarder that presents a loopback Host and adds no header (`socat`,
`ssh -R`, a proxy set to rewrite Host) gets through, and with it the source. Plain `http://` to another host is refused unless
`web.allow_insecure_origins = true` (or `BAZHEN_ALLOW_INSECURE_ORIGINS=true`), since anyone on the
network could read the traffic.

Once any external origin is set, every browser must pair before it can reach anything, on
loopback too. A proxy in front can make any request look like loopback's, so loopback alone
proves nothing. Run `bazhen pair` and enter the code it prints on the page. The code works once,
for 5 minutes, and after 20 wrong tries it is burned and `bazhen pair` must issue another. A
browser paired over HTTPS stays paired until it goes 30 days unused. One paired over plain HTTP
stays paired for a day: a browser sends a cookie to every port on a host, so other servers on
this machine's loopback can receive that one. `bazhen devices` lists paired browsers, and
`bazhen devices revoke <id>` ends one, closing the views it has open. Pairing guards the route,
but a paired phone can do anything you can: never put the route on the public internet. Limit
who can reach it with the route's own filter, such as Caddy's `remote_ip` matcher, which also
keeps strangers away from the pairing form.

With no external origin (`web.pairing = "auto"`, the default), Bazhen serves loopback only and
asks no browser to pair: any process or user on this machine that can reach the daemon's port
can drive your agents, as `bazhen doctor` says. A request a proxy forwarded from another
machine (its `X-Forwarded-For` or `Forwarded` header names one) must pair whatever the setting.
A forwarder that adds no such header, such as `ssh -R` or `socat` onto the daemon's or the dev
server's port, isn't noticed: with one, set `web.pairing = "always"`. On a machine other people log in to, set
`web.pairing = "always"` (or `BAZHEN_PAIRING=always`) to require pairing on loopback too.

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

## Tasks

A task is a title and a brief, given to agents as its coordinator, lead or worker. Giving an agent
a task mails it the brief and the commands to answer with:

| Command                                                  | Does                                                                                 |
| -------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `bazhen task list [--all]`                               | Open tasks; inside an agent, its own                                                 |
| `bazhen task show <task>`                                | One task in full: brief, assignments, subtasks, note                                 |
| `bazhen task create --title … --brief …\|--brief-file …` | A new task, optionally `--assign <agent> --role <role>`, or `--parent <task>`        |
| `bazhen task assign <task> <agent> [--role …]`           | Give the task to another agent                                                       |
| `bazhen task unassign <task> <assignment>`               | Take it back, with everything that agent handed on                                   |
| `bazhen task done [<task>] [--note …] [--cascade]`       | Finish it; a worker finishes only its own part. `--cascade` cancels subtasks         |
| `bazhen task cancel <task> [--note …] [--cascade]`       | Cancel it                                                                            |
| `bazhen agents`                                          | The agents running, by id, to delegate to                                            |
| `bazhen escalate <question> [--task …]`                  | Inside an agent: put a question or problem in the human's inbox                      |
| `bazhen delegate <agent> --title … --brief … [--task …]` | Inside an agent: hand part of a task it coordinates or leads to another agent        |
| `bazhen delegate --launch <harness> [--dir …] --title …` | The same, to a new agent it starts for the work, in its own directory unless `--dir` |

The human assigns any role. A coordinator gives the task to a lead or workers, a lead to workers,
and a worker to no one. Ending an assignment ends everything granted under it. Every agent
Bazhen launches is told these commands as it starts, beside its harness's own instructions. When an agent finishes a task you own, or a subtask falls to
you, it shows in your inbox.

**Who is asking.** Inside an agent, the CLI says which agent it is from `BAZHEN_AGENT_ID`, over the
daemon's 0600 Unix socket. The daemon takes that at its word, as it must take any process of
yours, which could drive the agent's terminal anyway, but refuses an agent that is closed, lost
or unknown. Over TCP, from the web client, the caller is always you.

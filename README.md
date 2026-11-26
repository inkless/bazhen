# Bazhen

Local-first environment for operating a fleet of 20+ concurrent development agents, with native
coordinator, workstream-lead, and worker roles and fully interactive terminals.

Early foundation: a local daemon that owns durable terminals, each held by a process of its own
([docs/holder.md](docs/holder.md)) or, where configured, on a private tmux server, and a web
client. Agents, tasks, and orchestration come later.

## Requirements

- Node.js 24 or newer (development uses the version `.nvmrc` pins)
- pnpm 12 (pinned through `packageManager`)
- [proto](https://moonrepo.dev/docs/proto/install), which installs moon, the repository's task
  runner, at the version `.prototools` pins
- tmux 3.x, only for terminals on tmux (`runtime.default = "tmux"`); 3.5 or later avoids a crash
  Bazhen can only work around before it ([docs/tmux.md](docs/tmux.md))
- Rust through rustup, which installs the toolchain `rust-toolchain.toml` pins on first use, and
  once per machine the cargo tools `moon run :check` and `moon run :test-falsify` run:
  `cargo install --locked cargo-nextest@0.9.152 cargo-deny@0.20.2 cargo-mutants@27.1.0`
- macOS or Linux
- For the tests that run real tmux, Docker, or Podman with its `docker` shim (`moon run :test-real`)

## Setup

Install proto once per machine, then, in the checkout:

```sh
proto install                   # moon, at the version .prototools pins
pnpm install --frozen-lockfile  # the dependencies, and the git hooks
moon run :check                 # every check CI runs on a workstation
```

Every command is a moon task: `moon tasks` lists them, and `moon run :<task> -- <args>` passes
arguments on to the task's command.

## Commands

| Command                             | Does                                                                                                                                     |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`    | Install exactly what the lockfile records, and the git hooks (husky)                                                                     |
| `moon run :dev`                     | Start the daemon (`http://127.0.0.1:7900`) and the web dev server (`http://127.0.0.1:7901`); no vite keyboard shortcuts                  |
| `moon run :bazhen -- <noun> <verb>` | The CLI: `start`, `stop`, `status`, `doctor`, `env refresh`, `devices [list \| pair \| revoke <id> \| dismiss <id>]`, and the rest below |
| `moon run :check`                   | Standards check, lint, format check, type-check, small and medium tests, clippy, cargo-deny, nextest                                     |
| `moon run :test`                    | Small tests                                                                                                                              |
| `moon run :test-real -- [suite…]`   | The tests that run real tmux, in a throwaway Linux container: integration, api, e2e                                                      |
| `moon run :test-falsify`            | Run the branch's new tests against the base's source, Rust ones against mutants of the change; CI runs it on PRs                         |
| `moon run :build`                   | Compile packages to `dist/`, build the web bundle, which the daemon serves at `http://127.0.0.1:7900`, and the holder                    |
| `moon run :format`                  | Rewrite files with oxfmt and rustfmt                                                                                                     |

Contributing, for people and agents: [AGENTS.md](AGENTS.md) and [docs/standards/](docs/standards/).

## Layout

- `apps/daemon` — the service: configuration and paths, HTTP API, SQLite store, PTY seam
- `crates/bazhen` — `bazhen`, the command agents and people run, a client of the daemon's Unix
  socket (Rust); `moon run :build` builds it at `target/release/bazhen`. `bazhen start` finds the
  checkout from the binary's resolved path, three levels up, so link to the binary rather than
  copy it, and keep it under the checkout: a `CARGO_TARGET_DIR` elsewhere breaks `start`.
  Agents run `bazhen` from their PATH, so link it into a directory on the PATH they start with,
  for example `ln -s "$PWD/target/release/bazhen" ~/.local/bin/bazhen`; `bazhen doctor` warns when
  agents find none, or one that isn't this checkout's build
- `crates/bazhen-hook` — `bazhen-hook`, the hook client harnesses run (Rust)
- `crates/bazhen-holder-proto` — `holder/1`, what the daemon and a PTY holder say (Rust)
- `crates/bazhen-holder` — `bazhen-holder`, the process that holds one terminal's PTY and child (Rust)
- `crates/bazhen-holder-engine` — a terminal's screen and compact history, for the PTY holder (Rust)
- `crates/bazhen-pid` — a process's session, group and socket peer as the kernel answers them,
  never taking the 0 it gives for one outside this PID namespace for a pid (Rust)
- `apps/web` — React + Vite client, with React Aria Components for its widgets (`docs/standards/ui.md`)
- `packages/protocol` — shared types, schemas, and the protocol id clients compare with the daemon's
- `packages/core` — domain model and state machines; no platform imports
- `packages/runtime-tmux` — the tmux runtime adapter
- `tests/integration` — tests against a private tmux server (container or CI only)
- `tests/e2e` — Playwright browser tests
- `tests/cli` — the `bazhen` CLI as a process, against a fake daemon

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
listen = "loopback" # or "lan" (BAZHEN_WEB_LISTEN), with lan_allow; see docs/lan.md

[notifications]
desktop = true # show what needs you on this machine's desktop while no dashboard is in sight

[shells]
retype_last_command = false # keep each shell's last line to type back; see docs/shell-integration.md

[runtime]
default = "holder" # or "tmux"; a terminal already open stays on the runtime it was made on

[attach]
detach_keys = "ctrl-],ctrl-]" # what detaches `bazhen terminals attach`, as ctrl-p,ctrl-q; or --detach-keys

[terminals]
max_open = 100 # agents' and shells' terminals open at once
history_lines = 10000 # lines of history each new terminal keeps, up to 100000; see below
memory_max = "50%" # each holder terminal's memory, where it can be contained; see docs/holder.md
total_memory_max = "80%" # every holder terminal's together: at least 64M, a whole 1-100%, or "infinity"
swap_max = "0" # each holder terminal's swap: bytes, "0" for none, or "infinity"
```

`bazhen terminals attach` uses the local terminal grid. When another view drives at a different
size, lines in a passive CLI view can wrap and scroll differently. Web views use the holder's grid.

A runtime that isn't the default and has no terminal open on it isn't read: `bazhen status` and
`bazhen doctor` show it as `unused`, and it can't fail doctor. Without tmux installed, a holder
daemon runs as usual.

Each line of history costs memory in every view of a terminal, and in the daemon's copy of each
tmux terminal: at 100,000 lines of 200 columns, a full history is roughly 240 MB per view.

Desktop notifications go through `notify-send` on Linux, and on macOS through Bazhen's own
notifier app, which `moon run :build-notify` builds with Xcode's command-line tools (restart the
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

### On each device

The web terminal's own settings stay in the browser that sets them, in its local storage, and
nothing syncs them: set them from the page's developer console, then reload.

- `bazhen.fontFamily`: a CSS family list, such as `"Iosevka Term", monospace`, to draw terminals
  in a font installed on that device. Quote a name that isn't only letters, digits, `-` and `_`.
  Terminals are drawn in JetBrainsMono Nerd Font Mono, which the page bundles, so Nerd Font icons
  work with nothing installed, and it still draws whatever glyph and icon the family you name
  lacks, or the whole terminal if the device doesn't have that family.
- `bazhen.keyMap`: keys over the defaults, as JSON, such as `{"shift+enter": "\u001b\r"}`; `null`
  unbinds a key.
- `bazhen.optionIsMeta`: `true` for a Mac's Option key to send Alt+letter rather than type the
  characters it puts on keys.

For example: `localStorage.setItem("bazhen.fontFamily", '"Iosevka Term", monospace')`. A value
the page can't use is shown above the terminal, which goes on without it.

### Reaching Bazhen from another device

The Rust daemon listens on `127.0.0.1` only and refuses `web.listen = "lan"`. To open it from
another machine, forward a port to it over SSH, through Tailscale or another VPN when the machines
aren't on one network: [docs/remote.md](docs/remote.md) is the supported route, and needs no proxy
or external origin. Only the LAN listener below, with [docs/lan.md](docs/lan.md), is the TypeScript
daemon's alone; a proxy route with external origins and pairing applies to both.

On your home network, the TypeScript daemon can serve HTTPS itself: set `web.listen = "lan"` and the
address ranges that may connect, and trust its certificate on the phone after checking its
fingerprint ([docs/lan.md](docs/lan.md)).

Otherwise Bazhen listens on `127.0.0.1` only and never terminates TLS. To open it from a phone, bring your
own route to that port that runs on this machine, such as a local reverse proxy: a proxy on
another host can't reach a loopback port. [docs/caddy.md](docs/caddy.md) sets up Caddy, with
your own domain or without one. Build the web app (`moon run :build`), point the route at the
daemon, `http://127.0.0.1:7900`, which serves the built app as well as the API, and list the address
it presents, exactly as the browser shows it (scheme, host and any port), in
`BAZHEN_EXTERNAL_ORIGINS` or `web.external_origins`:
`BAZHEN_EXTERNAL_ORIGINS=https://bazhen.example.com moon run :bazhen -- start`. The daemon then
accepts that address, and refuses every other non-loopback one; it logs it at start, and
`bazhen doctor` lists it. Build again after you pull: the daemon serves whatever was built last,
from the next page load on. Never point a route at the web dev server (`moon run :dev`, port 7901):
it serves the repository's source. It refuses a request with another Host, another page's Origin, or
a proxy's forwarding header, but a forwarder that presents a loopback Host and adds no header
(`socat`, `ssh -R`, a proxy set to rewrite Host) gets through, and with it the source. Plain
`http://` to another host is refused unless `web.allow_insecure_origins = true` (or
`BAZHEN_ALLOW_INSECURE_ORIGINS=true`), since anyone on the network could read the traffic.

Once any external origin is set, every browser must pair before it can reach anything, on
loopback too. A proxy in front can make any request look like loopback's, so loopback alone
proves nothing. Run `bazhen devices pair` and enter the code it prints on the page. The code works once,
for 5 minutes, and after 20 wrong tries it is burned and `bazhen devices pair` must issue another. A
browser paired over HTTPS stays paired until it goes 30 days unused. One paired over plain HTTP
stays paired for a day: a browser sends a cookie to every port on a host, so other servers on
this machine's loopback can receive that one. `bazhen devices` lists paired browsers, and
`bazhen devices revoke <id>` ends one, closing the views it has open. Each pairing shows in the
inbox, and on this machine's desktop as it happens, until `bazhen devices dismiss <id>` dismisses
it; no browser can, though a paired device can run that command in a shell, as it can anything.
Pairing guards the route, but a paired phone can do anything you can: never put the route on the
public internet. Limit who can reach it with the route's own filter, such as Caddy's `remote_ip`
matcher, which also keeps strangers away from the pairing form.

With no external origin (`web.pairing = "auto"`, the default), Bazhen serves loopback only and
asks no browser to pair: any process or user on this machine that can reach the daemon's port
can drive your agents, as `bazhen doctor` says. Your agents' own processes are among them, since
the daemon tells an agent from you only on its socket. A request a proxy forwarded from another
machine (its `X-Forwarded-For` or `Forwarded` header names one) must pair whatever the setting.
A forwarder that adds no such header, such as `ssh -R` or `socat` onto the daemon's or the dev
server's port, isn't noticed: with one, set `web.pairing = "always"`. On a machine other people log in to, set
`web.pairing = "always"` (or `BAZHEN_PAIRING=always`) to require pairing on loopback too.

## Installing Bazhen as an app on Linux and Windows

In a browser tab on a Linux, Windows or ChromeOS desktop, Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Shift+W and
Ctrl+Tab belong to the browser: they never reach the terminal, and Ctrl+W closes the tab. An
installed app's window passes Ctrl+W, Ctrl+T, Ctrl+N, Ctrl+Tab and Ctrl+Shift+Tab on to the
terminal. Ctrl+Shift+W still closes the window, and Ctrl+Shift+N still opens a browser window. Open
Bazhen in Chrome or Chromium, at `http://127.0.0.1:7900` or your HTTPS route, click the install
icon in the address bar, and open Bazhen from your app launcher from then on. The app runs in the
same browser profile, so at the same address it keeps the browser's pairing and needs no second
`bazhen devices pair`.

While Ctrl is down in a terminal, closing a tab, or the app's window, asks first: Ctrl+W in a tab,
and Ctrl+Shift+W in the app. Firefox can't install Bazhen as an app, so there the question is all
there is. A Mac doesn't lose Ctrl+W, and a phone or a tablet is touch-first, so Bazhen offers them
no app and doesn't ask.

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
`BAZHEN_HOME` relocates everything under one directory and gives it its own holders and tmux
server; `BAZHEN_BANK` relocates only the document bank. `BAZHEN_PORT` overrides the daemon's
port. `BAZHEN_CLAUDE_PERMISSION_MODE` starts every Claude Code agent in that permission mode
instead of the one your settings pick.

For tmux terminals, Bazhen only ever manages its own tmux server, by the socket `tmux.sock` in
its runtime directory (`tmux -S`), never your default one or any server found by name. To look at
it yourself: `tmux -S "$TMPDIR/bazhen/tmux.sock" ls` on macOS,
`tmux -S "$XDG_RUNTIME_DIR/bazhen/tmux.sock" ls` on Linux, or `<BAZHEN_HOME>/run/tmux.sock`
under a relocated home. A runtime directory whose socket path would be too long moves to
`/tmp/bazhen-<uid>-<hash>`.

If the runtime directory fits the daemon socket but is too long for a terminal holder socket,
holders use a private directory at `/tmp/bazhen-holders-<uid>-<hash>/holders`. The daemon and
tmux sockets keep their usual paths.

Every agent and shell Bazhen opens gets the daemon's socket as `BAZHEN_SOCKET`, and every
`bazhen` verb run there but `start` reaches that daemon. It wins over `BAZHEN_HOME` without a
word, as both come from the environment. A `--home` naming another daemon is refused instead
(exit 1), so `bazhen stop --home <dir>` typed in a Bazhen shell never stops the daemon hosting it.
To reach another instance from inside one, empty it: `BAZHEN_SOCKET= bazhen status --home <dir>`.
`start` ignores `BAZHEN_SOCKET`: it starts the daemon of the home `--home` or `BAZHEN_HOME` names,
else the default one.

When no daemon answers, a command says what it saw and exits 3. "Not running" means nothing is at
the socket and no daemon holds its start-up lock (`<socket>.lock`). A daemon that holds the lock
with no socket is stopping or still starting, and one that holds the socket but doesn't answer may
be stuck or busy. `bazhen stop` exits 0 when the daemon stopped, which is when it lets go of its
lock (a daemon stops answering as its drain begins), or wasn't running. A daemon with no socket
that holds the lock is waited on, up to 6 s, for the lock to free, or for the socket to answer so
it can be told to stop. Once a daemon has taken the stop, `stop` waits up to 6 s for its lock to
free, whatever its socket shows while it drains. If another daemon answers on the socket first, as
one another shell started does once the lock frees, `stop` exits 0 too, adding "another daemon now
answers on <socket>". It exits 1 when either wait runs out, when a stuck daemon doesn't answer, or
when the daemon is still answering 5 s after it was told to stop.

## Tasks

A task is a title and a brief, given to agents as its coordinator, lead or worker. Giving an agent
a task mails it the brief and the commands to answer with:

| Command                                                        | Does                                                                                   |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `bazhen tasks list [--all]`                                    | Open tasks; inside an agent, its own                                                   |
| `bazhen tasks show <task>`                                     | One task in full: brief, assignments, subtasks, note                                   |
| `bazhen tasks create --title … --brief …\|--brief-file …`      | A new task, optionally `--assign <agent> --role <role>`, or `--parent <task>`          |
| `bazhen tasks assign <task> <agent> [--role …]`                | Give the task to another agent                                                         |
| `bazhen tasks unassign <task> <assignment>`                    | Take it back, with everything that agent handed on                                     |
| `bazhen tasks done [<task>] [--note …] [--cascade]`            | Finish it; a worker finishes only its own part. `--cascade` cancels subtasks           |
| `bazhen tasks cancel <task> [--note …] [--cascade]`            | Cancel it                                                                              |
| `bazhen tasks send <task> <text>\|--file …`                    | Message everyone else on the task                                                      |
| `bazhen tasks wait <task> done`                                | Wait until the task is done, or no one is still on it and someone completed their part |
| `bazhen agents list [--json]`                                  | The agents running, by name and id, to delegate to                                     |
| `bazhen agents whoami`                                         | Inside an agent: its name, id, tasks, and whom it reports to on each                   |
| `bazhen roles`                                                 | The roles defined, what each hands on, and any role file skipped                       |
| `bazhen agents rename <agent> <name>`                          | Rename an agent; inside an agent, only itself                                          |
| `bazhen agents wait <agent> idle\|ready\|ended\|<state>`       | Wait until the agent is idle, running, closed or failed, or in a lifecycle state       |
| `bazhen agents send <agent> <text> --reply`                    | Inside an agent: send, then wait for that agent's reply                                |
| `bazhen inbox escalate <question> [--task …]`                  | Inside an agent: put a question or problem in the human's inbox                        |
| `bazhen tasks delegate <agent> --title … --brief … [--task …]` | Inside an agent: hand part of a task it coordinates or leads to another agent          |
| `bazhen tasks delegate --launch <harness> [--dir …] --title …` | The same, to a new agent it starts for the work, in its own directory unless `--dir`   |

`<agent>` is an agent's name or its id. Every agent has a name, unique among those not closed or
failed: the one it was launched with (`--name`), or `<project>-<n>`, whose number is never given
twice. Claude Code shows it as its session's name, which keeps the old one after a rename until the
agent next starts. Mail stays with the agent's id, which a rename doesn't change.

A Claude Code agent runs `bazhen agents list`, `agents whoami`, `agents rename`, `agents send`, `agents wait`,
every `bazhen tasks` verb, `bazhen inbox escalate` and `bazhen roles` without a permission
prompt: the settings it starts with allow them, beside your own, and the daemon decides what each
agent may do with them. Other `bazhen` commands still ask, the other `agents` verbs among them, and so
does one given a file to read (`--file`, `--brief-file`), which would otherwise put any file the
agent can read into mail without a prompt. An agent
that messages another with Claude Code's own SendMessage instead of `bazhen agents send` shows the
message on both agents' pages, as sent and with delivery not tracked: Bazhen sees it leave, never
arrive. It is matched to the agent whose session answers to the name it was sent to, the name
that agent was last started with.

### Waiting

A wait blocks until what it waits for happens, then exits once, so an agent can run one in the
background and act when it ends, rather than polling `agents list` or sleeping. The daemon judges
the wait when it arrives and again after every change it records, so nothing that happens between
asking and listening is missed. An agent is `idle` once its harness reports a turn ended after
every message sent to it arrived: an agent just sent work isn't idle until it has taken it up,
whether as a new turn or folded into the one it is running. One that was idle when the daemon
restarted, with no message since, is still idle; one that was busy is idle once it next reports
a turn ended, and the wait says so. `ready` is `running`, its harness up.

`--reply` prints who replied and the reply's id, not its text, which arrives as mail. A reply is
the first message the agent sends back after yours reached it: one it wrote before then crossed
yours. Only the agent that sent a message may wait for its reply.

Each wait exits 0 when it happened; 1 when it can't now, as when the agent ended otherwise or the
task was cancelled; 4 when a `--reply` message bounced; 5 when `--timeout` ran out first (60 s
unless given, and at least 1 s), counting the time to find the name and to send; and 3 when no
daemon is running. While the daemon is away it tries again until it is back or the timeout runs
out. `--json` prints the daemon's whole answer. A caller may wait on any agent, shell or task it
can read in `/v1/state`, and is told nothing more than that shows, and may hold up to 64 waits at
once. `bazhen shells wait <shell> <state>|ended` waits on a shell the same way.

Roles are configuration. Bazhen ships four, coordinator, lead, worker and reviewer, each a
Markdown file whose front matter says which roles it may hand on (`grants`), whether a task has
only one (`singlePerTask`) and how many tasks an agent may hold in it at once
(`maxActiveTasks`), and whose body is the role's prompt. A file
`~/.config/bazhen/roles/<role>.md` replaces the built-in of its name whole, or adds a role, and
takes effect at its next use. A file that doesn't parse is reported and skipped, and the built-in
stands; `bazhen roles` lists both.

An agent launched in a role starts with Bazhen's fleet instructions, then `## Your role: <title>`
and the role's prompt. `tasks delegate --launch` launches in the role it delegates; a launch request
names one with `role`. Claude Code reads the prompt from a file only you can read, in the daemon's
run directory (`--append-system-prompt-file`), so it is never in a process's arguments; Codex gets
it in its thread's first item. An edit to the role's file reaches the agent at its next start, and
until then the state snapshot marks its prompt changed. Given a role it wasn't launched in, an
agent's brief carries that role's prompt the first time.

The human assigns any role. As shipped, a coordinator gives the task to a lead, workers or
reviewers, a lead to workers or reviewers, and a worker or reviewer to no one; a worker holds one
task at a time. An agent whose role grants something runs the task: its `done` finishes it. One
whose role grants nothing finishes only its own part, so a role file that drops a role's grants
also takes away its say over the task. Ending an assignment ends everything granted under it. Every agent
Bazhen launches is told these commands as it starts, beside its harness's own instructions. When an agent finishes a task you own, or a subtask falls to
you, it shows in your inbox.

**Who is asking.** Inside an agent, the CLI says which agent it is, by `BAZHEN_AGENT_ID` and the
token in `BAZHEN_AGENT_AUTH_FILE`, over the daemon's 0600 Unix socket, the one in `BAZHEN_SOCKET`:
the daemon that started it, wherever its home is. The daemon checks that against the process that
calls (see below). Without a peer reading, it takes that at its word, but refuses an agent that is
closed, lost or unknown. Over TCP, from the web client, the caller is always you.

A verb that defaults to the asking agent (`agents whoami`, `tasks list`, and `tasks done` or
`tasks note` with no task named) asks the daemon which agent it takes the command for, and uses that one,
whatever the environment names, and even when it names no agent. A Codex command's
`BAZHEN_AGENT_ID` can be whichever agent started its app-server, and a process in an agent's
terminal is that agent's with no variable set. With no daemon running, these verbs say so and
exit 3.

## Running agents from a shell

The verbs the web client's agent controls use, for a terminal or a script:

| Command                                                                                               | Does                                                                                                                      |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `bazhen agents launch claude-code\|codex [--dir …] [--name …] [--role …] [--compact-window <tokens>]` | Start an agent in `--dir`, else where the command runs; `--compact-window` sets when its harness compacts, on every start |
| `bazhen agents close <agent> [--confirm-busy] [--force]`                                              | Close it; `--confirm-busy` also ends what runs in its shells                                                              |
| `bazhen agents respawn <agent>`                                                                       | Start an exited agent again, on its harness session                                                                       |
| `bazhen agents relaunch <agent> [--fresh]`                                                            | Start a lost agent again on a new terminal; `--fresh` if its session can't resume                                         |
| `bazhen agents signal <agent> INT\|TERM\|HUP\|KILL`                                                   | Send its process a signal, named with or without `SIG`                                                                    |
| `bazhen shells list [--all]`                                                                          | The shells neither closed nor failed, or with `--all` every one                                                           |
| `bazhen shells open [<agent> \| --dir …]`                                                             | A shell beside an agent, in its directory, else in `--dir` or where it runs                                               |
| `bazhen shells close <shell> [--confirm-busy] [--force]`                                              | Close a shell, named by its id or a name one open shell has, in any case                                                  |
| `bazhen events follow [--after <event>]`                                                              | Each event as it happens, until Ctrl-C; it tries again while the daemon is away                                           |

All but `shells list`, which only reads, are yours alone: the daemon refuses them to an agent, and
the CLI prints its refusal. A command acts on the agent or shell as `/v1/state` shows it at that
moment, by its id; if it moved on before the command arrived, the daemon refuses it as stale and
nothing is tried again. Each exits 0 when done (or there was nothing to do), 1 when refused, 2 on a
mistake in the command line, with nothing sent, and 3 when no daemon is running. `--json` prints the
CLI's reading of the daemon's answer: `{ agentId, eventIds }`, and a launch's `terminalId`; for a
shell `{ terminalId, eventIds }`, and for `shells list` the shells as `/v1/state` shows them.

`events follow` prints a line an event, or with `--json` each event as the daemon sent it, and
says so when events were missed and it follows on from the daemon's state. An agent's harness
compacting its context shows as `agent.compacted`, with the context use recorded before it.
`events follow` is yours alone too: the daemon refuses an agent the event stream. Ctrl-C ends `events follow` at once while it waits on the stream, and within 5 s while it waits
on a call to the daemon, such as opening the stream again.

## What Bazhen knows about who is calling

With the peer reader running, a call on the daemon's socket from inside an agent is that agent's.
Each start of an agent gets a token, in a file only you can read, which its `bazhen` commands and
hooks present. A token shows only that the call is yours: any of your processes, other agents
included, can read the file. The daemon also reads which process made the call. A process running
in an agent's terminal is that agent's, whether or not it presents a token. Any token it presents
must be that agent's own. So an agent can't answer approvals, pair or revoke a browser, stop the
daemon, change the environment later agents get, launch agents outside a delegation's limits, run
other agents' terminals or the shells, or pass as another agent. That holds even when it unsets
its environment. Only a call made outside every agent's terminal is yours.

Codex runs an agent's commands in its app-server, outside the agent's terminal. So a call from a
process under a Codex app-server (`codex app-server`, the managed one included), or from one whose
environment Codex gave a `CODEX_THREAD_ID`, as a command left running after its shell exits, is
never yours. It is the agent whose thread `CODEX_THREAD_ID` names, which `bazhen` sends, and is
refused when that thread is no live agent's, such as your own Codex session's. Bazhen gives each
agent's thread `BAZHEN_SOCKET`, so its commands reach the daemon that launched it. The server
keeps the environment of whatever started it, which can be a `codex app-server daemon start` or
`codex update` run inside an agent. So each agent's thread also sets `BAZHEN_AGENT_ID` and
`BAZHEN_AGENT_AUTH_FILE` empty, and under the server the thread alone says which agent a call is. The daemon knows
the server by its command line (`codex` or `codex-<platform>`, run as `app-server`), so a Codex
that renames its binary or that subcommand would be missed; `moon run :test-real -- api` checks the
Codex the tests install, and `bazhen doctor` warns when a live Codex agent's server doesn't match.

Every Codex agent's commands run under the same server, so only the thread a call names tells one
Codex agent from another, and any of them can name another's. A process in an agent's terminal
stays that agent's for ordinary calls, whatever thread it names; an agent that deliberately fakes a
Codex server above itself (`exec -a codex … app-server`) is outside these checks, like the other
deliberate cases below. A command in Codex's
`workspace-write` sandbox can't reach the daemon's socket at all; run `bazhen` outside it. On
macOS, the kernel hides the environment of a process it restricts (`cs_restricted`, unless SIP is
off), so a command left running after its shell exits is marked only when it isn't one; the
`bazhen` CLI isn't. On Linux, the kernel hides a process's environment from the daemon when the
process runs as another of your groups, as a `newgrp` or `sg` shell's do. Such a call is marked
by the `CODEX_THREAD_ID` that `bazhen` sends instead, so a client that sends none, left running
after its shell exits, isn't marked.

The Rust daemon reads the caller of a loopback HTTP request the same way: as the processes that
hold the connection's other end, which Linux's `/proc` names. So an agent's `curl`, script or
browser is refused over HTTP what it is refused on the socket, and the refusal names the process it
read and the agent's terminal it was started from. A browser first started from an agent's
terminal, as `xdg-open` starts one for a dev server or a login step when no browser is running, is
that agent's until you restart it outside Bazhen. A connection that another user's process holds,
such as a proxy's, is refused. So is one forwarded by `ssh -L`, whose `sshd` can't be read, until
the browser is paired through that forward once: then a request through it that carries the
paired browser's cookie is yours, as long as every process of yours that may hold its socket
unseen reads as yours (docs/remote.md, Pairing). `hidepid` hides only other users' processes, so
it leaves this working. Where `/proc` doesn't say who holds a socket (`/proc` mounted with
`subset=pid`, which hides `/proc/net`; a daemon in another PID namespace; or macOS), every API
request over HTTP is refused: the daemon warns at start, and `bazhen doctor` shows
`HTTP callers: unidentified`.

These checks catch an agent's ordinary and accidental calls, not a determined agent's. Agents run
as you, the same user, so an agent that does any of these looks like you to Bazhen:

- leaves its terminal's process tree
  (`setsid -f env -u BAZHEN_AGENT_ID -u BAZHEN_AGENT_AUTH_FILE bazhen devices pair`, `systemd-run --user`,
  `at`), or, from Codex, leaves the app-server's tree with `CODEX_THREAD_ID` unset;
- types into one of your shells (`tmux -S <socket> send-keys -t <shell pane>`);
- reaches the TypeScript daemon's web port on loopback where pairing isn't required (trusted by
  design under `web.pairing = "auto"`), or the Rust daemon's through a forwarder you started, such
  as the web client's dev server, or by driving your browser;
- rewrites Bazhen's files.

Run agents inside their harness's sandbox to stop those.

A process that takes a caller's pid after it exits is told apart by its start time. Within about 3
seconds of the connection, it can still pass as that caller. On macOS the socket may name the last
process to use it rather than the one that connected, as XNU's source reads, though that hasn't
been checked on a Mac; how far the start time and session checks cover that there is untested.

Without the peer reader, the daemon can't read which process calls. Then a call from inside an
agent that presents nothing passes as yours, and one that presents another agent's token, which
it can read, passes as that agent. The daemon warns at start, and `bazhen doctor` shows
`peer reader: none`. `moon run :build` builds `bazhen-peer`, which the daemon installs at start.

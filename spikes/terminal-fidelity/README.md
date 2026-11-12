# Spike C: browser terminal fidelity (throwaway)

A throwaway harness that checks whether real Claude Code and Codex TUIs stay usable in xterm.js 6
when the bytes come from one daemon-held `tmux attach` client per viewed terminal (foundation
design §4.2, §4.3, §5.3, §5.4). It is not product code and nothing imports it. The findings and
their evidence live in the task's notes, not here.

## Pieces

| File | Role |
|---|---|
| `server.ts` | The "daemon": private tmux server, one node-pty attach client per viewed terminal fanned out to every WebSocket view, a headless emulator for the attach snapshot, a minimal driver lease, and a small control API for the scenarios. Binds `127.0.0.1` only. |
| `client/` | The page: xterm.js 6 with WebGL, fit and unicode11, and a `window.spike` hook for Playwright. |
| `probe.ts` | Runs in a pane in place of a TUI and logs every input chunk as hex. |
| `tui-sim.ts` | A minimal alt-screen program that redraws on resize, used for the width checks. |
| `fakes/` | Local fake model APIs (copied from the sibling hook-mailbox and app-server spikes, plus a long-reply marker), so the TUIs run with dummy keys and no network. |
| `scenarios/` | Playwright scenarios S1–S6; `tuis.ts` sets up the isolated TUI environments. |

## Run

```sh
pnpm install          # standalone package, outside the product workspace
pnpm build            # bundles client/ into dist/
pnpm test             # Playwright starts and stops server.ts itself
pnpm test s4-resize   # one scenario
```

Raw results, screenshots and byte logs go to `out/` (gitignored).

Knobs (environment variables read by `server.ts`):

| Variable | Effect |
|---|---|
| `BZ_SPIKE_TMUX_EXTRA` | Extra lines appended to the tmux config, e.g. `set -ga terminal-overrides ",xterm-256color:smcup@:rmcup@"` |
| `BZ_SPIKE_REPLIES=browser` | Let each browser answer tmux's terminal queries instead of the daemon (reproduces the held-Esc defect) |
| `BZ_SPIKE_SYNC_SERIALIZE=1` | Serialize the snapshot without draining the headless emulator first (reproduces the snapshot gap) |
| `BZ_SPIKE_HEADLESS_UNICODE6=1` | Leave the headless emulator on Unicode 6 widths (reproduces the emoji-row mismatch) |
| `BZ_SPIKE_DIRTY_ENV=1` | Start tmux with the full parent environment instead of the allowlist |

## Hygiene

- tmux runs on a private server, `tmux -L bz-spike-c-<pid>`, started from an allowlisted
  environment. The server process kills it and removes its socket on SIGINT and SIGTERM.
- The TUIs are isolated with `CLAUDE_CONFIG_DIR` and `CODEX_HOME` in a temp dir, and with file
  credential stores. `HOME` is never overridden. No real credentials are used: both point at the
  local fakes with dummy keys.
- On macOS, `lsof | grep -c /dev/ptmx` counts PTYs in use. Each run asserts that the server holds
  no PTY after its views close.

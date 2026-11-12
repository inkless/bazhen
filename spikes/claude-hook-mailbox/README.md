# Claude Code hook mailbox spike

Throwaway probes that check the hook facts the mailbox design rests on, against a real
interactive Claude Code TUI. Pinned to Claude Code **2.1.322**. Not product code.

Run any probe with plain Node (no dependencies): `node probe-smoke.ts`.

## How a probe runs

- `fake-anthropic.ts` is a fake Anthropic Messages API, so turns need no account and cost
  nothing. It logs every request body, which shows exactly what the model would have received.
- `env.ts` creates a temp dir per run and isolates Claude Code with `CLAUDE_CONFIG_DIR` only.
  **Never override `HOME`**: Claude Code calls macOS `security`, and a fake `HOME` raises
  "keychain not found" dialogs. Each run uses a private tmux server (`tmux -L bz-spike-*`),
  passes `--setting-sources project --settings <run>/settings.json`, and kills the server and
  deletes its socket on exit. It refuses to start when more than 420 PTYs are in use.
- `hooks/record.ts` appends every hook payload to `<run>/hooks.jsonl`.

## Probes

| Probe | Question |
|---|---|
| `probe-smoke.ts` | One turn against the fake; isolation from the user's own Claude Code |
| `probe-wake.ts` | Does an `asyncRewake` waiter wake an idle session, reliably and after hours (`--idle-sec`)? |
| `probe-rotation.ts` | `session_id` and `SessionStart.source` across `/clear`, `/compact`, resume, fork |
| `probe-autocompact.ts` | The same for auto-compaction |
| `probe-subagent.ts` | Subagent hook fields, and where a `PostToolUse` fold lands |
| `probe-permission.ts` | `PermissionRequest`: no decision, allow, deny, late decisions, timeout |
| `probe-interrupt.ts` | Esc mid-stream and mid-tool; are async hooks held to `timeout`? |
| `probe-races.ts` | Two waiters, mail mid-turn, stale waiters after `/clear` |
| `probe-stopfailure.ts` | API errors and `StopFailure` |
| `summarize-ids.ts` | `session_id` / `prompt_id` / `agent_id` coverage across run dirs |

Each run leaves `hooks.jsonl`, `requests.jsonl`, `waiter.jsonl` and `result.json` in its temp
dir for inspection.

## Using the fake API on its own

```sh
node fake-anthropic.ts --port 0 --log /tmp/requests.jsonl --port-file /tmp/fake.port
```

Then start Claude Code with:

```sh
CLAUDE_CONFIG_DIR=<temp dir> \
ANTHROPIC_BASE_URL=http://127.0.0.1:$(cat /tmp/fake.port) \
ANTHROPIC_API_KEY=sk-ant-fake-spike-0000000000000000000000 \
CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 DISABLE_AUTOUPDATER=1 \
claude --setting-sources project --permission-mode default
```

To skip the first-run dialogs, write `<temp dir>/.claude.json` before launch:
`hasCompletedOnboarding: true`, `customApiKeyResponses.approved` holding the key's last 20
characters, and `projects["<realpath of cwd>"].hasTrustDialogAccepted: true` (see `seedConfig()`
in `env.ts`). The path must be the realpath (`/private/var/...` on macOS).

The reply is chosen by a marker in the prompt: `[[fake:plain]]` (default), `[[fake:slow:<sec>]]`,
`[[fake:bash:<cmd>]]`, `[[fake:tools:<n>]]`, `[[fake:agent]]`. See the header of
`fake-anthropic.ts`.

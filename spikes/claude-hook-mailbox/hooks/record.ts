// Records one hook invocation: `node record.ts <EventName>`.
// Appends {event, received_at, pid, ppid, env, payload} to $BZ_SPIKE_DIR/hooks.jsonl and exits 0.
import { appendFileSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.BZ_SPIKE_DIR;
if (!dir) process.exit(0);
let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {}
let payload: unknown = raw;
try {
  payload = JSON.parse(raw);
} catch {}
const entry = {
  event: process.argv[2] ?? "?",
  received_at: new Date().toISOString(),
  pid: process.pid,
  ppid: process.ppid,
  // Names only (never values): which harness variables reached the hook.
  env_names: Object.keys(process.env)
    .filter((k) => /CLAUDE|ANTHROPIC|MESSAGING|FORCE_COLOR|TRIAGE|CODEX/.test(k))
    .sort(),
  // Non-secret identity values, to tell the probed session's own variables from inherited ones.
  env_ids: {
    CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID ?? null,
    CLAUDE_CODE_MESSAGING_SOCKET: process.env.CLAUDE_CODE_MESSAGING_SOCKET ?? null,
    CLAUDE_PID: process.env.CLAUDE_PID ?? null,
    CLAUDE_CODE_CHILD_SESSION: process.env.CLAUDE_CODE_CHILD_SESSION ?? null,
  },
  payload,
};
appendFileSync(join(dir, "hooks.jsonl"), JSON.stringify(entry) + "\n");

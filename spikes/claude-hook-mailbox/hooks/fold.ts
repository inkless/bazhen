// A PostToolUse mail fold: `node fold.ts`.
// If $BZ_SPIKE_DIR/fold.json holds {"when": "any"|"main"|"subagent", "text": "..."} and this
// event matches `when` (subagent = payload carries agent_id), it returns the text as
// additionalContext and deletes the file. Every call is logged to fold.jsonl.
import { appendFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.BZ_SPIKE_DIR;
if (!dir) process.exit(0);
let payload: Record<string, unknown> = {};
try {
  payload = JSON.parse(readFileSync(0, "utf8")) as Record<string, unknown>;
} catch {}
const queue = join(dir, "fold.json");
const isSub = payload.agent_id !== undefined && payload.agent_id !== null;
let folded = false;
if (existsSync(queue)) {
  const q = JSON.parse(readFileSync(queue, "utf8")) as { when: string; text: string };
  if (q.when === "any" || (q.when === "subagent") === isSub) {
    rmSync(queue);
    folded = true;
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: q.text } }),
    );
  }
}
appendFileSync(
  join(dir, "fold.jsonl"),
  JSON.stringify({
    at: new Date().toISOString(),
    folded,
    session_id: payload.session_id ?? null,
    prompt_id: payload.prompt_id ?? null,
    agent_id: payload.agent_id ?? null,
    agent_type: payload.agent_type ?? null,
    tool_name: payload.tool_name ?? null,
  }) + "\n",
);

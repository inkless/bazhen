// ID coverage: for every hook event recorded across the given run dirs, how often session_id,
// prompt_id and agent_id are present. Usage: node summarize-ids.ts <run dir>...
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type Row = { n: number; session: number; prompt: number; agent: number; keys: Set<string> };
const rows = new Map<string, Row>();
for (const dir of process.argv.slice(2)) {
  const f = join(dir, "hooks.jsonl");
  if (!existsSync(f)) continue;
  for (const line of readFileSync(f, "utf8").split("\n").filter(Boolean)) {
    const e = JSON.parse(line) as { event: string; payload: Record<string, unknown> };
    const p = e.payload;
    const key = p.agent_id ? `${e.event} (subagent)` : e.event;
    const r = rows.get(key) ?? { n: 0, session: 0, prompt: 0, agent: 0, keys: new Set<string>() };
    r.n++;
    if (p.session_id) r.session++;
    if (p.prompt_id) r.prompt++;
    if (p.agent_id) r.agent++;
    for (const k of Object.keys(p)) r.keys.add(k);
    rows.set(key, r);
  }
}
console.log("| Event | n | session_id | prompt_id | agent_id |");
console.log("|---|---|---|---|---|");
for (const [ev, r] of [...rows].sort()) console.log(`| ${ev} | ${r.n} | ${r.session} | ${r.prompt} | ${r.agent} |`);

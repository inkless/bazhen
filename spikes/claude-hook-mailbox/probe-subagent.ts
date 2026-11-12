// Are subagent hook events distinguishable, and where does a fold land?
// Case 1 folds during the subagent's Bash PostToolUse; case 2 folds during a main-agent
// Bash PostToolUse (the control).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { node, recordingHooks, Run, sleep } from "./env.ts";

const run = new Run("subagent");
type Out = Record<string, unknown>;
const out: Out = {};

/** Which logged request first contains `needle`, and whose request it was. */
function whereLanded(needle: string) {
  const reqs = run.requests();
  for (let i = 0; i < reqs.length; i++) {
    const body = reqs[i]!.body as { messages?: { role: string; content: unknown }[]; system?: unknown } | undefined;
    const msgs = body?.messages ?? [];
    const idx = msgs.findIndex((m) => JSON.stringify(m.content).includes(needle));
    if (idx < 0) continue;
    const first = JSON.stringify(msgs.find((m) => m.role === "user")?.content ?? "");
    const m = msgs[idx]!;
    const blocks = Array.isArray(m.content) ? (m.content as Record<string, unknown>[]) : [];
    return {
      request: i,
      whose: first.includes("Run the probe") && !first.includes("spawn [[") ? "subagent" : "main",
      message: `${idx + 1}/${msgs.length}`,
      role: m.role,
      blockTypes: blocks.map((b) => b.type),
      block: JSON.stringify(blocks.find((b) => JSON.stringify(b).includes(needle)) ?? m.content).slice(0, 700),
    };
  }
  return null;
}

try {
  await run.startFake();
  run.writeSettings(
    recordingHooks({
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: node("hooks/fold.ts"), timeout: 10 }] }],
    }),
    { permissions: { allow: ["Bash(echo:*)"] } },
  );
  run.launch("a", []);
  await run.waitEvent("SessionStart", 0, 30_000);

  // Case 1: fold into the subagent's tool call.
  const fold1 = `FOLD-SUB-${run.id}`;
  writeFileSync(join(run.dir, "fold.json"), JSON.stringify({ when: "subagent", text: fold1 }));
  let before = run.hooks().length;
  await run.type("a", "spawn [[fake:agent:echo from-subagent]]");
  await run.waitEvent("Stop", before, 60_000);
  await sleep(1500);
  const case1 = run.hooks().slice(before);
  out.case1_events = case1.map((h) => ({
    event: h.event,
    session_id: h.payload.session_id,
    prompt_id: h.payload.prompt_id ?? null,
    agent_id: h.payload.agent_id ?? null,
    agent_type: h.payload.agent_type ?? null,
    tool: h.payload.tool_name ?? null,
    keys: Object.keys(h.payload),
  }));
  out.case1_landed = whereLanded(fold1);

  // Case 2: fold into a main-agent tool call (control).
  const fold2 = `FOLD-MAIN-${run.id}`;
  writeFileSync(join(run.dir, "fold.json"), JSON.stringify({ when: "main", text: fold2 }));
  before = run.hooks().length;
  await run.type("a", "tool [[fake:bash:echo main-tool]]");
  await run.waitEvent("Stop", before, 60_000);
  await sleep(1500);
  out.case2_landed = whereLanded(fold2);
  out.subagentPayloads = run
    .hooks()
    .filter((h) => ["SubagentStart", "SubagentStop"].includes(h.event))
    .map((h) => ({ event: h.event, payload: { ...h.payload, transcript_path: "<run>", agent_transcript_path: "<run>", cwd: "<run>" } }));
  console.log(run.capture("a").split("\n").filter((l) => l.trim()).slice(-22).join("\n"));
} catch (e) {
  console.log("ERROR", e, "\n" + run.capture("a"));
} finally {
  writeFileSync(join(run.dir, "result.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, null, 1).slice(0, 9000));
  console.log(JSON.stringify({ ...(await run.cleanup()), dir: run.dir }));
}

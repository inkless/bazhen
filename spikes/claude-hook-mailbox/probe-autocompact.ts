// Auto-compaction: report a huge input-token count, then take another turn, and see
// whether auto-compaction runs and what session_id/source it produces.
// Usage: node probe-autocompact.ts [--tokens 990000] [--pct 50] [--window <tokens>]
import { parseArgs } from "node:util";
import { recordingHooks, Run, sleep } from "./env.ts";

const { values } = parseArgs({
  options: {
    tokens: { type: "string", default: "990000" },
    pct: { type: "string", default: "50" },
    window: { type: "string" },
  },
});
const run = new Run("autocompact");
try {
  await run.startFake();
  run.writeSettings(recordingHooks());
  const env: Record<string, string> = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: values.pct! };
  if (values.window) env.CLAUDE_CODE_AUTO_COMPACT_WINDOW = values.window;
  run.launch("a", [], env);
  await run.waitEvent("SessionStart", 0, 30_000);
  for (const text of ["one [[fake:plain]]", `grow [[fake:big:${values.tokens}]]`, "two [[fake:plain]]", "three [[fake:plain]]"]) {
    const before = run.hooks().length;
    await run.type("a", text);
    await run.waitEvent("Stop", before, 90_000);
    await sleep(2000);
  }
  for (const h of run.hooks())
    console.log(h.event, String(h.payload.session_id).slice(0, 8), String(h.payload.prompt_id ?? "-").slice(0, 8), h.payload.source ?? h.payload.trigger ?? "");
  console.log(run.capture("a").split("\n").filter((l) => l.trim()).slice(-14).join("\n"));
} finally {
  console.log(JSON.stringify({ ...(await run.cleanup()), dir: run.dir }));
}

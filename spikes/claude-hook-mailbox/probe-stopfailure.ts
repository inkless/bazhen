// The mailbox design relies on StopFailure. Does an API error end the turn with StopFailure, and
// what does its payload carry? Cases: 400 (not retried), 500 and 529 with retries disabled.
// Records every event of the full canonical list, so newly seen events show up too.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { recordingHooks, Run, sleep } from "./env.ts";

const run = new Run("stopfail");
const out: Record<string, unknown>[] = [];
try {
  await run.startFake();
  run.writeSettings(recordingHooks());
  run.launch("a", [], { CLAUDE_CODE_MAX_RETRIES: "0" });
  await run.waitEvent("SessionStart", 0, 30_000);
  for (const status of [400, 500, 529]) {
    const before = run.hooks().length;
    const t0 = Date.now();
    await run.type("a", `err [[fake:error:${status}]]`);
    await sleep(10_000);
    const evs = run.hooks().slice(before);
    const rec = {
      status,
      events: evs.map((h) => `${h.event}@${Date.parse(h.received_at) - t0}ms`),
      stopFailure: evs.find((h) => h.event === "StopFailure")?.payload ?? null,
      requests: run.requests().filter((r) => Date.parse(String(r.at)) >= t0).length,
      screen: run.capture("a").split("\n").filter((l) => l.trim()).slice(-6, -3),
    };
    out.push(rec);
    console.log(JSON.stringify(rec, null, 1));
  }
  const before = run.hooks().length;
  await run.type("a", "after [[fake:plain]]");
  await run.waitEvent("Stop", before, 20_000);
  console.log("recovered: next turn reached Stop");
} catch (e) {
  console.log("ERROR", e, run.capture("a"));
} finally {
  writeFileSync(join(run.dir, "result.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ ...(await run.cleanup()), dir: run.dir }));
}

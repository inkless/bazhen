// Wake an idle session through an asyncRewake waiter, repeatedly.
// Usage: node probe-wake.ts [--wakes 20] [--idle-sec 0] [--label wake]
// With --idle-sec N, the session idles N seconds before the last wake (the long-idle case).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Mailbox } from "./mailbox.ts";
import { recordingHooks, Run, sleep, waiterHooks } from "./env.ts";

const { values } = parseArgs({
  options: {
    wakes: { type: "string", default: "20" },
    "idle-sec": { type: "string", default: "0" },
    label: { type: "string", default: "wake" },
  },
});
const wakes = Number(values.wakes);
const idleSec = Number(values["idle-sec"]);

const run = new Run(values.label!);
const mb = new Mailbox(run.sock);
const results: Record<string, unknown>[] = [];
try {
  await mb.start();
  await run.startFake();
  run.writeSettings(recordingHooks(waiterHooks()));
  run.launch("a", [], { BZ_WAITER_HEARTBEAT_SEC: idleSec > 0 ? "600" : "300" });
  await run.waitEvent("SessionStart", 0, 30_000);
  await run.waitFor("first waiter", () => mb.live().length > 0, 20_000);
  await sleep(1000);

  for (let i = 1; i <= wakes; i++) {
    if (i === wakes && idleSec > 0) {
      console.log(`idling ${idleSec}s before the last wake`);
      await sleep(idleSec * 1000);
    }
    const before = run.hooks().length;
    const marker = `MAIL-${run.id}-${i}`;
    const w = await run.waitFor("a live waiter", () => mb.live().at(-1), 30_000).catch(() => undefined);
    if (!w) {
      results.push({ i, ok: false, reason: "no live waiter" });
      console.log(`wake ${i}: no live waiter`);
      continue;
    }
    const sentAt = Date.now();
    mb.send(`[[fake:plain]] ${marker}`);
    let stop;
    try {
      stop = await run.waitEvent("Stop", before, 30_000);
    } catch {
      results.push({ i, ok: false, reason: "no Stop after mail", waiter: { pid: w.pid, event: w.event } });
      console.log(`wake ${i}: no Stop`);
      continue;
    }
    const seen = run.findInRequests(marker);
    const newEvents = run.hooks().slice(before);
    results.push({
      i,
      ok: Boolean(seen),
      latency_ms: Date.parse(stop.received_at) - sentAt,
      waiter: { pid: w.pid, event: w.event, prompt_id_at_start: w.prompt_id },
      stop_prompt_id: stop.payload.prompt_id ?? null,
      stop_session_id: stop.payload.session_id ?? null,
      events: newEvents.map((h) => h.event),
      model_saw: i <= 2 || i === wakes ? seen : seen ? "(same shape)" : null,
    });
    console.log(`wake ${i}: ok=${Boolean(seen)} prompt_id=${String(stop.payload.prompt_id)} events=${newEvents.map((h) => h.event).join(",")}`);
    await sleep(1500);
  }
  console.log("--- screen ---\n" + run.capture("a"));
} finally {
  const out = {
    results,
    mailboxLog: mb.log,
    waiterLog: run.waiterLog(),
    hooks: run.hooks().map((h) => ({
      event: h.event,
      at: h.received_at,
      session_id: h.payload.session_id ?? null,
      prompt_id: h.payload.prompt_id ?? null,
      keys: Object.keys(h.payload),
    })),
  };
  writeFileSync(join(run.dir, "result.json"), JSON.stringify(out, null, 2));
  mb.close();
  const res = await run.cleanup();
  console.log(JSON.stringify({ ...res, dir: run.dir }, null, 2));
}

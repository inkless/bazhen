// Which session_id and SessionStart source each rotation produces, and what happens to
// the live waiter across it. Steps: startup, /clear, /compact, auto-compaction, resume, fork.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Mailbox } from "./mailbox.ts";
import { recordingHooks, Run, sleep, waiterHooks, type Recorded } from "./env.ts";

const run = new Run("rotation");
const mb = new Mailbox(run.sock);
mb.oneWaiterPerSession = false; // observe what Claude Code does on its own
const steps: Record<string, unknown>[] = [];

function summarize(evs: Recorded[]) {
  return evs.map((h) => ({
    event: h.event,
    session_id: h.payload.session_id ?? null,
    prompt_id: h.payload.prompt_id ?? null,
    source: h.payload.source ?? h.payload.trigger ?? h.payload.reason ?? null,
  }));
}

async function step(name: string, act: () => Promise<void>, settleMs = 4000) {
  const before = run.hooks().length;
  const waitersBefore = mb.live().map((w) => ({ pid: w.pid, event: w.event, session_id: w.session_id }));
  await act();
  await sleep(settleMs);
  const evs = run.hooks().slice(before);
  const rec = {
    step: name,
    events: summarize(evs),
    waitersBefore,
    waitersAfter: mb.live().map((w) => ({ pid: w.pid, event: w.event, session_id: w.session_id })),
  };
  steps.push(rec);
  console.log(`== ${name}`);
  for (const e of rec.events) console.log(`   ${e.event} sid=${String(e.session_id).slice(0, 8)} pid=${String(e.prompt_id).slice(0, 8)} src=${e.source}`);
  console.log(`   waiters: ${rec.waitersAfter.map((w) => `${w.event}/${String(w.session_id).slice(0, 8)}`).join(" ")}`);
  return evs;
}

const turn = (win: string, text: string) => async () => {
  const before = run.hooks().length;
  await run.type(win, text);
  await run.waitEvent("Stop", before, 60_000);
};

try {
  await mb.start();
  await run.startFake();
  run.writeSettings(recordingHooks(waiterHooks()));
  const env = { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: "50" };
  let sid = "";
  await step("startup", async () => {
    run.launch("a", [], env);
    const s = await run.waitEvent("SessionStart", 0, 30_000);
    sid = String(s.payload.session_id);
  });
  await step("turn-1", turn("a", "first [[fake:plain]]"));
  await step("clear", async () => {
    await run.type("a", "/clear");
  });
  await step("turn-after-clear", turn("a", "after clear [[fake:plain]]"));
  await step("compact", async () => {
    await run.type("a", "/compact");
  }, 8000);
  await step("turn-after-compact", turn("a", "after compact [[fake:plain]]"));
  await step("big-turn", turn("a", "grow [[fake:big:190000]]"));
  await step("turn-after-big (auto-compact?)", turn("a", "next [[fake:plain]]"), 8000);
  const last = run.hooks().filter((h) => h.event === "Stop").at(-1)!;
  sid = String(last.payload.session_id);
  console.log("screen before exit:\n" + run.capture("a").split("\n").filter((l) => l.trim()).slice(-25).join("\n"));
  await step("exit", async () => {
    await run.type("a", "/exit");
  });
  await step("resume", async () => {
    run.launch("b", ["--resume", sid], env);
    await run.waitEvent("SessionStart", run.hooks().length, 30_000);
  });
  await step("turn-after-resume", turn("b", "after resume [[fake:plain]]"));
  await step("exit-b", async () => {
    await run.type("b", "/exit");
  });
  await step("fork", async () => {
    run.launch("c", ["--resume", sid, "--fork-session"], env);
    await run.waitEvent("SessionStart", run.hooks().length, 30_000);
  });
  await step("turn-after-fork", turn("c", "after fork [[fake:plain]]"));
  await step("exit-c", async () => {
    await run.type("c", "/exit");
  });
} catch (e) {
  console.log("ERROR", e);
  for (const w of ["a", "b", "c"]) {
    try {
      console.log(`--- ${w} ---\n` + run.capture(w).split("\n").filter((l) => l.trim()).slice(-20).join("\n"));
    } catch {}
  }
} finally {
  writeFileSync(join(run.dir, "result.json"), JSON.stringify({ steps, mailboxLog: mb.log, waiterLog: run.waiterLog() }, null, 2));
  mb.close();
  const res = await run.cleanup();
  console.log(JSON.stringify({ ...res, dir: run.dir }, null, 2));
}

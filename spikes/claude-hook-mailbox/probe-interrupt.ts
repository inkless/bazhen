// Does Esc fire Stop or StopFailure (mid-stream, mid-tool)? Which waiters are live
// after an interrupt? Are async and asyncRewake hooks held to their timeout?
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Mailbox } from "./mailbox.ts";
import { node, recordingHooks, Run, sleep, waiterHooks, type Hooks } from "./env.ts";

const run = new Run("interrupt");
const mb = new Mailbox(run.sock);
mb.oneWaiterPerSession = false;
const out: Record<string, unknown> = {};
const sleeperLog = () =>
  existsSync(join(run.dir, "sleeper.jsonl"))
    ? readFileSync(join(run.dir, "sleeper.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>)
    : [];
const live = () => mb.live().map((w) => `${w.event}/${String(w.prompt_id).slice(0, 8)}`);

async function interruptCase(name: string, prompt: string, waitFor: string | null, afterMs: number) {
  const before = run.hooks().length;
  const t0 = Date.now();
  await run.type("a", prompt);
  if (waitFor) await run.waitEvent(waitFor, before, 20_000);
  await sleep(afterMs);
  const waitersBefore = live();
  run.keys("a", "Escape");
  const escAt = Date.now() - t0;
  await sleep(5000);
  const evs = run.hooks().slice(before);
  const rec = {
    name,
    escAtMs: escAt,
    events: evs.map((h) => `${h.event}${h.payload.reason ? ":" + String(h.payload.reason) : ""}${h.payload.error ? ":" + String(h.payload.error) : ""}@${Date.parse(h.received_at) - t0}ms`),
    waitersBefore,
    waitersAfter: live(),
    screen: run.capture("a").split("\n").filter((l) => l.trim()).slice(-8),
  };
  out[name] = rec;
  console.log(JSON.stringify(rec, null, 1));
}

try {
  await mb.start();
  await run.startFake();
  const sleepers: Hooks = {
    Stop: [
      { hooks: [{ type: "command", command: node("hooks/sleeper.ts", "async-t3", "8", "0"), async: true, timeout: 3, once: true }] },
      { hooks: [{ type: "command", command: node("hooks/sleeper.ts", "rewake-t3", "8", "2"), asyncRewake: true, timeout: 3, once: true }] },
    ],
  };
  const extra: Hooks = { ...waiterHooks() };
  extra.Stop = [...(extra.Stop ?? []), ...sleepers.Stop!];
  run.writeSettings(recordingHooks(extra), { permissions: { allow: ["Bash(sleep:*)"] } });
  run.launch("a", []);
  await run.waitEvent("SessionStart", 0, 30_000);
  await run.waitFor("waiter", () => mb.live().length > 0, 20_000);

  // Async timeout: the first Stop starts both sleepers (timeout 3 s, sleep 8 s).
  let before = run.hooks().length;
  await run.type("a", "first [[fake:plain]]");
  await run.waitEvent("Stop", before, 30_000);
  await sleep(12_000);
  const sleeperWake = run.findInRequests("SLEEPER-rewake-t3");
  out.asyncTimeout = { sleeperLog: sleeperLog(), rewakeReachedModel: sleeperWake ?? null, eventsSince: run.hooks().slice(before).map((h) => h.event) };
  console.log(JSON.stringify(out.asyncTimeout, null, 1));

  await interruptCase("esc-mid-stream", "stream [[fake:slow:12]]", "UserPromptSubmit", 2000);
  await interruptCase("esc-mid-tool", "tool [[fake:bash:sleep 12]]", "PreToolUse", 1500);

  // After the interrupts: does mail still wake the session, and is the next prompt_id new?
  before = run.hooks().length;
  const w = mb.live().at(-1);
  if (w) {
    mb.send(`[[fake:plain]] MAIL-after-interrupt-${run.id}`);
    const s = await run.waitEvent("Stop", before, 20_000).catch(() => undefined);
    out.mailAfterInterrupt = { waiter: `${w.event}/${String(w.prompt_id).slice(0, 8)}`, woke: Boolean(s), prompt_id: s?.payload.prompt_id ?? null };
  } else out.mailAfterInterrupt = { waiter: null };
  console.log(JSON.stringify(out.mailAfterInterrupt));
} catch (e) {
  console.log("ERROR", e, run.capture("a"));
} finally {
  writeFileSync(join(run.dir, "result.json"), JSON.stringify({ ...out, mailboxLog: mb.log }, null, 2));
  mb.close();
  console.log(JSON.stringify({ ...(await run.cleanup()), dir: run.dir }));
}

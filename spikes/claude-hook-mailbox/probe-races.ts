// Waiter races.
//  A. Two distinct waiter entries on Stop, plus an exact duplicate entry: how many start, and
//     what does mail to both at once produce (one turn or two)?
//  B. Mail to the previous turn's waiter while a turn is running (slow stream, then tool steps).
//  C. After /clear, mail only to the old session's waiter: does it wake the new session?
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Mailbox } from "./mailbox.ts";
import { node, recordingHooks, Run, sleep, type Hooks } from "./env.ts";

const run = new Run("races");
const mb = new Mailbox(run.sock);
mb.oneWaiterPerSession = false;
const out: Record<string, unknown> = {};
const short = (s: unknown) => String(s).slice(0, 8);
const live = () => mb.live().map((w) => `${w.event}/${short(w.session_id)}/${short(w.prompt_id)}`);
const turnsSince = (i: number) =>
  run
    .hooks()
    .slice(i)
    .filter((h) => ["UserPromptSubmit", "Stop", "SessionStart", "SessionEnd", "PostToolUse"].includes(h.event))
    .map((h) => `${h.event}/${short(h.payload.session_id)}/${short(h.payload.prompt_id)}`);

try {
  await mb.start();
  await run.startFake();
  const waiter = (label: string) => ({ type: "command", command: node("hooks/waiter.ts", label), asyncRewake: true, timeout: 86400 });
  const extra: Hooks = {
    SessionStart: [{ hooks: [waiter("SessionStart")] }],
    Stop: [{ hooks: [waiter("Stop")] }, { hooks: [waiter("Stop-b")] }, { hooks: [waiter("Stop")] }],
  };
  run.writeSettings(recordingHooks(extra), { permissions: { allow: ["Bash(echo:*)"] } });
  run.launch("a", []);
  await run.waitEvent("SessionStart", 0, 30_000);
  await run.waitFor("SessionStart waiter", () => mb.live().length > 0, 20_000);
  // Retire the SessionStart waiter so case A sees only Stop waiters.
  for (const w of mb.live()) w.sock.write(JSON.stringify({ release: true }) + "\n");
  await sleep(500);

  // A: one Stop, three entries (two identical).
  let before = run.hooks().length;
  await run.type("a", "first [[fake:plain]]");
  await run.waitEvent("Stop", before, 30_000);
  await sleep(2000);
  const started = mb.waiters.filter((w) => w.event.startsWith("Stop")).map((w) => w.event);
  before = run.hooks().length;
  const sent = mb.sendAll(`[[fake:plain]] RACE-A-${run.id}`).map((w) => w.event);
  await sleep(8000);
  const reqsWithA = run.requests().filter((r) => JSON.stringify(r.body ?? "").includes(`RACE-A-${run.id}`)).length;
  const firstA = run.findInRequests(`RACE-A-${run.id}`);
  out.A = {
    waitersStartedOnOneStop: started,
    mailSentTo: sent,
    turnsAfter: turnsSince(before),
    requestsContainingMail: reqsWithA,
    occurrencesInFirstRequest: firstA ? (JSON.stringify(run.requests()[firstA.index]!.body).match(new RegExp(`RACE-A-${run.id}`, "g")) ?? []).length : 0,
    liveAfter: live(),
  };
  console.log("A", JSON.stringify(out.A, null, 1));
  // Release everything so B starts from exactly the waiters of one Stop.
  for (const w of mb.live()) w.sock.write(JSON.stringify({ release: true }) + "\n");
  await sleep(500);
  before = run.hooks().length;
  await run.type("a", "reset [[fake:plain]]");
  await run.waitEvent("Stop", before, 30_000);
  await sleep(2000);

  // B1: mail mid-stream (slow reply with no tools).
  before = run.hooks().length;
  await run.type("a", "slow [[fake:slow:8]]");
  await run.waitEvent("UserPromptSubmit", before, 20_000);
  await sleep(2000);
  const liveB1 = live();
  mb.send(`[[fake:plain]] RACE-B1-${run.id}`);
  await sleep(14_000);
  const b1 = run.findInRequests(`RACE-B1-${run.id}`);
  out.B1 = { liveAtSend: liveB1, turnsAfter: turnsSince(before), landed: b1 ? { request: b1.index, position: b1.position, role: b1.role } : null };
  console.log("B1", JSON.stringify(out.B1, null, 1));
  for (const w of mb.live()) w.sock.write(JSON.stringify({ release: true }) + "\n");
  await sleep(500);
  before = run.hooks().length;
  await run.type("a", "reset2 [[fake:plain]]");
  await run.waitEvent("Stop", before, 30_000);
  await sleep(2000);

  // B2: mail during a multi-step tool turn.
  before = run.hooks().length;
  await run.type("a", "steps [[fake:tools:4]]");
  await run.waitEvent("PostToolUse", before, 20_000);
  mb.send(`[[fake:plain]] RACE-B2-${run.id}`);
  await sleep(14_000);
  const b2 = run.findInRequests(`RACE-B2-${run.id}`);
  const reqs = run.requests();
  out.B2 = {
    turnsAfter: turnsSince(before),
    landed: b2 ? { request: b2.index, of: reqs.length, position: b2.position, role: b2.role, block: b2.text.slice(0, 300) } : null,
  };
  console.log("B2", JSON.stringify(out.B2, null, 1));

  // C: /clear, then mail only to the old session's waiters.
  await sleep(1000);
  const oldSid = String(run.hooks().filter((h) => h.event === "Stop").at(-1)!.payload.session_id);
  before = run.hooks().length;
  await run.type("a", "/clear");
  const ss = await run.waitEvent("SessionStart", before, 20_000);
  await sleep(2000);
  const newSid = String(ss.payload.session_id);
  const liveC = live();
  before = run.hooks().length;
  const toOld = mb.send(`[[fake:plain]] RACE-C-${run.id}`, oldSid);
  await sleep(8000);
  out.C = {
    oldSid: short(oldSid),
    newSid: short(newSid),
    liveAtSend: liveC,
    sentTo: toOld ? `${toOld.event}/${short(toOld.session_id)}` : null,
    turnsAfter: turnsSince(before),
    reachedModel: Boolean(run.findInRequests(`RACE-C-${run.id}`)),
  };
  console.log("C", JSON.stringify(out.C, null, 1));
} catch (e) {
  console.log("ERROR", e, run.capture("a"));
} finally {
  writeFileSync(join(run.dir, "result.json"), JSON.stringify({ ...out, mailboxLog: mb.log }, null, 2));
  mb.close();
  console.log(JSON.stringify({ ...(await run.cleanup()), dir: run.dir }));
}

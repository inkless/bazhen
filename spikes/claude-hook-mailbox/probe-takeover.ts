// Take over a running long-idle run early: serve its waiter socket again, wait for the waiter to
// reconnect, send one mail, and check it woke the session. Then clean the run up.
// Usage: node probe-takeover.ts <run dir>   (after the owning probe-wake process has stopped)
import { execFileSync, spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { Mailbox } from "./mailbox.ts";
import { baseEnv, HERE, sleep } from "./env.ts";

const dir = process.argv[2]!;
const id = dir.split("-").pop()!;
const sockPath = `/tmp/bz30-${id}.sock`;
const tmuxSocket = basename(dir).replace(/^bz-spike-longidle-/, `bz-spike-longidle-`);
const port = Number(readFileSync(join(dir, "fake.port"), "utf8"));
const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>) : []);

// The fake may have died with its parent; restart it on the same port the session uses.
let fakePid: number | undefined;
try {
  execFileSync("node", ["-e", `require("net").connect(${port},"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))`]);
  console.log("fake still up on", port);
} catch {
  const f = spawn("node", ["--disable-warning=ExperimentalWarning", join(HERE, "fake-anthropic.ts"), "--port", String(port), "--log", join(dir, "requests.jsonl")], { stdio: "ignore" });
  fakePid = f.pid;
  await sleep(1000);
  console.log("restarted fake on", port);
}

const mb = new Mailbox(sockPath);
mb.oneWaiterPerSession = false;
await mb.start();
const t0 = Date.now();
while (mb.live().length === 0 && Date.now() - t0 < 60_000) await sleep(200);
const w = mb.live().at(-1);
console.log("waiter reconnected:", w ? { pid: w.pid, event: w.event, after_ms: Date.now() - t0 } : null);
const hooksBefore = lines(join(dir, "hooks.jsonl")).length;
const marker = `MAIL-${id}-takeover`;
const sentAt = Date.now();
if (w) mb.send(`[[fake:plain]] ${marker}`);
let stop: Record<string, unknown> | undefined;
while (Date.now() - sentAt < 30_000) {
  stop = lines(join(dir, "hooks.jsonl")).slice(hooksBefore).find((h) => h.event === "Stop");
  if (stop) break;
  await sleep(200);
}
const seen = lines(join(dir, "requests.jsonl")).some((r) => JSON.stringify(r).includes(marker));
const waiterLog = lines(join(dir, "waiter.jsonl")).filter((x) => x.pid === w?.pid);
const first = waiterLog[0];
console.log(
  JSON.stringify(
    {
      woke: Boolean(stop),
      latency_ms: stop ? Date.parse(String(stop.received_at)) - sentAt : null,
      modelSawMail: seen,
      stop_prompt_id: (stop?.payload as Record<string, unknown> | undefined)?.prompt_id ?? null,
      waiter_started: first?.at,
      waiter_alive_sec_at_wake: waiterLog.filter((x) => x.what === "wake").at(-1)?.alive_sec ?? null,
      waiter_events: [...new Set(waiterLog.map((x) => x.what))],
    },
    null,
    1,
  ),
);

mb.close();
try {
  execFileSync("tmux", ["-L", tmuxSocket, "kill-server"], { env: baseEnv(), stdio: "ignore" });
} catch {}
if (fakePid) process.kill(fakePid);
await sleep(500);
rmSync(join(`/private/tmp/tmux-${process.getuid?.() ?? 0}`, tmuxSocket), { force: true });
console.log("cleaned:", tmuxSocket);

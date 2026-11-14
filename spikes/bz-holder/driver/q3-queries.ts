// Q3, queries with the daemon down: bz-probe runs in a holder nobody is subscribed to, writes
// each query 20 times and times the reply. Pass: every reply within 50 ms. Then a lone Esc,
// sent as input with nobody subscribed, must reach the child within 10 ms.
import fs from "node:fs";
import path from "node:path";
import { Conn, K, PROBE, frame, makeHome, percentile, ptyGuard, reap, sleep, spawnHolder } from "./lib.ts";

const COUNT = 20;
const KINDS = ["cpr", "da1", "da2", "xtversion", "osc10", "osc11"];
ptyGuard(KINDS.length + 1);
const home = makeHome("q3");
const holders = [];
let failures = 0;

const lines = (file: string) =>
  fs.existsSync(file)
    ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
    : [];

async function waitFor(file: string, n: number, ms = 10_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline && lines(file).length < n) await sleep(20);
  return lines(file);
}

for (const kind of KINDS) {
  const out = path.join(home, `${kind}.jsonl`);
  holders.push(await spawnHolder(home, kind, [PROBE, kind, out, String(COUNT)]));
  const results = (await waitFor(out, COUNT + 1)).filter((r) => r.kind === kind);
  const micros = results.map((r) => r.micros as number);
  const answered = results.filter((r) => r.answered).length;
  const max = Math.max(...micros);
  const ok = results.length === COUNT && answered === COUNT && max <= 50_000;
  if (!ok) failures++;
  console.log(
    JSON.stringify({
      query: kind,
      answered: `${answered}/${COUNT}`,
      p50us: percentile(micros, 50),
      p99us: percentile(micros, 99),
      maxUs: max,
      reply: results[0]?.reply,
      result: ok ? "PASS" : "FAIL",
    }),
  );
}

const out = path.join(home, "esc.jsonl");
const h = await spawnHolder(home, "esc", [PROBE, "esc", out, String(COUNT)]);
holders.push(h);
await waitFor(out, 1);
const conn = await Conn.connect(h.socket);
const sent: number[] = [];
for (let i = 0; i < COUNT; i++) {
  sent.push(Math.round((performance.timeOrigin + performance.now()) * 1000));
  conn.send(frame(K.INPUT, "\x1b"));
  await sleep(50);
}
const arrivals = (await waitFor(out, COUNT + 1)).filter((r) => r.kind === "esc");
const delays = arrivals.map((r) => (r.atMicros as number) - sent[r.i as number]!);
const escOk = arrivals.length === COUNT && Math.max(...delays) <= 10_000;
if (!escOk) failures++;
console.log(
  JSON.stringify({
    query: "lone-esc",
    arrived: `${arrivals.length}/${COUNT}`,
    p50us: percentile(delays, 50),
    p99us: percentile(delays, 99),
    maxUs: Math.max(...delays),
    result: escOk ? "PASS" : "FAIL",
  }),
);
conn.close();

const { leftAlive } = await reap(holders);
console.log(JSON.stringify({ failures, leftAlive }));
fs.rmSync(home, { recursive: true, force: true });
process.exit(failures === 0 && leftAlive.length === 0 ? 0 : 1);

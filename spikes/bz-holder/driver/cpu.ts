// CPU by the method of the earlier tmux measurement (CPU-time deltas over 15 s; /proc on Linux, ps -o time= on macOS):
//  (a) 25 busy-agent replays at 50 lines/s, 2 of them subscribed;
//  (b) 5 `yes` floods, 2 subscribed, plus an echo terminal (cat) to time keystroke echo.
// Reports the holders' summed CPU as a % of one core, the driver's own, and echo p50/p99.
import path from "node:path";
import fs from "node:fs";
import {
  Conn,
  K,
  PROGRAMS,
  REPLAY,
  type HolderRef,
  bytesOf,
  cpuSeconds,
  frame,
  makeHome,
  percentile,
  ptyGuard,
  reap,
  sleep,
  spawnHolder,
} from "./lib.ts";

const WINDOW_S = 15;
ptyGuard(31);
const home = makeHome("cpu");
const agent = path.join(PROGRAMS, "recordings", "agent-synthetic.bin");
const all: HolderRef[] = [];

async function subscribe(h: HolderRef): Promise<Conn> {
  const c = await Conn.connect(h.socket);
  c.send(frame(K.SNAPSHOT), frame(K.SUBSCRIBE));
  return c;
}

async function measure(holders: HolderRef[], extra?: () => Promise<number[]>) {
  const before = holders.map((h) => cpuSeconds(h.pid));
  const self0 = process.cpuUsage();
  const t0 = performance.now();
  const echo = extra ? await extra() : [];
  const remaining = WINDOW_S * 1000 - (performance.now() - t0);
  if (remaining > 0) await sleep(remaining);
  const seconds = (performance.now() - t0) / 1000;
  const after = holders.map((h) => cpuSeconds(h.pid));
  const used = after.reduce((a, b, i) => a + b - before[i]!, 0);
  const self = process.cpuUsage(self0);
  const perHolder = after.map((a, i) => ((a - before[i]!) / seconds) * 100);
  return {
    holdersCpuPct: Math.round((used / seconds) * 1000) / 10,
    maxHolderPct: Math.round(Math.max(...perHolder) * 10) / 10,
    driverCpuPct: Math.round(((self.user + self.system) / 1e6 / seconds) * 1000) / 10,
    echoP50ms: echo.length ? percentile(echo, 50) : undefined,
    echoP99ms: echo.length ? percentile(echo, 99) : undefined,
    echoSamples: echo.length || undefined,
  };
}

// (a)
const busy: HolderRef[] = [];
for (let i = 0; i < 25; i++) busy.push(await spawnHolder(home, `agent${i}`, [REPLAY, agent, "50"]));
all.push(...busy);
const subsA = [await subscribe(busy[0]!), await subscribe(busy[1]!)];
let bytesA = 0;
for (const c of subsA) c.onFrame = (f) => void (f.kind === K.R_DATA && (bytesA += bytesOf(f).length));
await sleep(2000);
const a = await measure(busy);
console.log(JSON.stringify({ workload: "25 busy agents, 2 subscribed", ...a, subscribedKBps: Math.round(bytesA / 1024 / (WINDOW_S + 2) / 2) }));
for (const c of subsA) c.close();
await reap(busy);

// (b)
const floods: HolderRef[] = [];
for (let i = 0; i < 5; i++) floods.push(await spawnHolder(home, `yes${i}`, ["yes"]));
const echoH = await spawnHolder(home, "echo", ["/bin/sh", "-c", "stty raw -echo; exec cat"]);
all.push(...floods, echoH);
const subsB = [await subscribe(floods[0]!), await subscribe(floods[1]!)];
let floodBytes = 0;
for (const c of subsB) c.onFrame = (f) => void (f.kind === K.R_DATA && (floodBytes += bytesOf(f).length));
const echoConn = await subscribe(echoH);
await sleep(2000);
const startBytes = floodBytes;
const b = await measure([...floods, echoH], async () => {
  const samples: number[] = [];
  for (let i = 0; i < 200; i++) {
    const marker = `k${i % 10}`;
    const sent = performance.now();
    const got = new Promise<void>((resolve) => {
      echoConn.onFrame = (f) => {
        if (f.kind === K.R_DATA && bytesOf(f).toString().includes(marker)) resolve();
      };
    });
    echoConn.send(frame(K.INPUT, marker));
    await got;
    samples.push(Math.round((performance.now() - sent) * 100) / 100);
    await sleep(50);
  }
  return samples;
});
console.log(
  JSON.stringify({
    workload: "5 yes floods, 2 subscribed, + echo terminal",
    ...b,
    subscribedMBps: Math.round(((floodBytes - startBytes) / 1024 / 1024 / WINDOW_S / 2) * 10) / 10,
  }),
);
for (const c of [...subsB, echoConn]) c.close();
const { leftAlive } = await reap(all);
console.log(JSON.stringify({ leftAlive }));
fs.rmSync(home, { recursive: true, force: true });

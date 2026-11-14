import { Conn, cpuSeconds, makeHome, reap, sleep, spawnHolder } from "./lib.ts"; import fs from "node:fs";
const home = makeHome("rate"); const load = process.argv[2] ?? "yes"; const h = await spawnHolder(home, "flood", ["/bin/sh", "-c", load]);
await sleep(1000); const c = await Conn.connect(h.socket);
const s0 = await c.stats(); const c0 = cpuSeconds(h.pid); const p0 = cpuSeconds(h.childPid); const t0 = performance.now();
await sleep(5000);
const s1 = await c.stats(); const c1 = cpuSeconds(h.pid); const p1 = cpuSeconds(h.childPid); const dt = (performance.now() - t0) / 1000; c.close();
const mbps = (s1.offset - s0.offset) / 1048576 / dt;
console.log(JSON.stringify({ holderMBps: Math.round(mbps), holderCpuPct: Math.round(((c1 - c0) / dt) * 100), yesCpuPct: Math.round(((p1 - p0) / dt) * 100), holderCpuMsPerMB: Math.round((((c1 - c0) / dt) * 1000) / mbps * 10) / 10 }));
console.log(JSON.stringify(await reap([h]))); fs.rmSync(home, { recursive: true, force: true });

// Q4, memory: one holder at 0, 2,000 and 10,000 lines of 160-column SGR-heavy output, then 25
// holders at 10,000 lines each. Reports the holder's own stats and ps RSS per terminal.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Conn, PROGRAMS, type HolderRef, makeHome, ptyGuard, reap, rssKb, sleep, spawnHolder } from "./lib.ts";

const COLS = 160;
const ROWS = 50;
ptyGuard(26);
const home = makeHome("q4");
const files: Record<number, string> = {};
for (const n of [2000, 10_000]) {
  files[n] = path.join(home, `sgr${n}.txt`);
  spawnSync("node", [path.join(PROGRAMS, "gen.ts"), "sgr160", files[n]!, String(n)], { stdio: "inherit" });
}

async function settled(h: HolderRef) {
  const c = await Conn.connect(h.socket);
  let last = -1;
  for (;;) {
    const s = await c.stats();
    if (s.offset === last) {
      c.close();
      return s;
    }
    last = s.offset;
    await sleep(300);
  }
}

const argv = (n: number) =>
  n === 0 ? ["/bin/sh", "-c", "exec sleep 600"] : ["/bin/sh", "-c", `cat '${files[n]}'; exec sleep 600`];

const all: HolderRef[] = [];
const MB = (b: number) => Math.round((b / 1024 / 1024) * 10) / 10;
for (const n of [0, 2000, 10_000]) {
  const h = await spawnHolder(home, `one${n}`, argv(n), { cols: COLS, rows: ROWS });
  all.push(h);
  const s = await settled(h);
  console.log(
    JSON.stringify({
      lines: n,
      outputMB: MB(s.offset),
      rssMB: MB(rssKb(h.pid) * 1024),
      engineMB: MB(s.engineBytes),
      ringMB: MB(s.ringBytes),
      historyLines: s.historyLines,
    }),
  );
}

const many: HolderRef[] = [];
for (let i = 0; i < 25; i++) {
  many.push(await spawnHolder(home, `many${i}`, argv(10_000), { cols: COLS, rows: ROWS }));
}
all.push(...many);
const stats = [];
for (const h of many) stats.push({ s: await settled(h), rss: rssKb(h.pid) * 1024 });
const rss = stats.map((x) => x.rss);
console.log(
  JSON.stringify({
    holders: 25,
    linesEach: 10_000,
    totalRssMB: MB(rss.reduce((a, b) => a + b, 0)),
    perTerminalRssMB: { min: MB(Math.min(...rss)), max: MB(Math.max(...rss)) },
    perTerminalEngineMB: MB(stats[0]!.s.engineBytes),
    perTerminalRingMB: MB(stats[0]!.s.ringBytes),
  }),
);
const { leftAlive } = await reap(all);
console.log(JSON.stringify({ leftAlive }));
fs.rmSync(home, { recursive: true, force: true });

// Q2, snapshot at offset: while `seq 1 200000` loops at full speed, attach (snapshot +
// subscribe in one write), take live bytes for a few ms, then ask for a second snapshot at Z and
// detach. Per cycle:
//  - seam: xterm(snapshot S + live bytes [S, Z)) equals xterm(snapshot Z), cell for cell;
//  - truth: its lines are consecutive seq numbers: none missing, none duplicated.
import fs from "node:fs";
import {
  Conn,
  K,
  bytesOf,
  clean,
  diffTerms,
  frame,
  logicalLines,
  makeHome,
  newTerm,
  offsetOf,
  ptyGuard,
  reap,
  sleep,
  spawnHolder,
  write,
} from "./lib.ts";

const CYCLES = Number(process.argv[2] ?? 1000);
const COLS = 120;
const ROWS = 40;
ptyGuard(1);
const home = makeHome("q2");
const h = await spawnHolder(home, "seq", ["/bin/sh", "-c", "while :; do seq 1 200000; done"], {
  cols: COLS,
  rows: ROWS,
});
await sleep(500);

const totals = { cycles: 0, seamDiffs: 0, missing: 0, duplicated: 0, gaps: 0, liveBytes: 0, lines: 0 };
const failures: string[] = [];

for (let i = 0; i < CYCLES; i++) {
  const c = await Conn.connect(h.socket);
  const data: Buffer[] = [];
  let expected = -1n;
  let got = 0n;
  let gap = false;
  c.onFrame = (f) => {
    if (f.kind === K.R_GAP) gap = true;
    if (f.kind === K.R_SNAPSHOT && expected < 0n) expected = got = offsetOf(f);
    if (f.kind !== K.R_DATA) return;
    const at = offsetOf(f);
    if (expected >= 0n && at !== expected) gap = true;
    const bytes = bytesOf(f);
    data.push(bytes);
    expected = at + BigInt(bytes.length);
    got = expected;
  };
  const first = c.next(K.R_SNAPSHOT);
  c.send(frame(K.SNAPSHOT), frame(K.SUBSCRIBE));
  const s = await first;
  const start = offsetOf(s);
  await sleep(2 + Math.floor(Math.random() * 20));
  const second = c.next(K.R_SNAPSHOT);
  c.send(frame(K.SNAPSHOT));
  const z = await second;
  const end = offsetOf(z);
  while (got < end && !c.isClosed) await sleep(1);
  c.close();

  const live = Buffer.concat(data).subarray(0, Number(end - start));
  const attached = newTerm(COLS, ROWS);
  await write(attached, bytesOf(s));
  await write(attached, live);
  const truth = newTerm(COLS, ROWS);
  await write(truth, bytesOf(z));
  const d = diffTerms(truth, attached);

  const lines = logicalLines(attached).slice(0, -1).filter((l) => l !== "");
  let missing = 0;
  let duplicated = 0;
  for (let j = 1; j < lines.length; j++) {
    const prev = Number(lines[j - 1]);
    const next = Number(lines[j]);
    if (next === prev + 1 || (prev === 200000 && next === 1)) continue;
    if (next <= prev && !(prev === 200000)) duplicated++;
    else missing++;
  }
  totals.cycles++;
  totals.liveBytes += live.length;
  totals.lines += lines.length;
  totals.missing += missing;
  totals.duplicated += duplicated;
  if (gap) totals.gaps++;
  if (!clean(d)) {
    totals.seamDiffs++;
    if (failures.length < 3) failures.push(JSON.stringify({ cycle: i, start, end, d }));
  }
  if (missing + duplicated > 0 && failures.length < 3) {
    failures.push(JSON.stringify({ cycle: i, missing, duplicated, sample: lines.slice(0, 3) }));
  }
  attached.dispose();
  truth.dispose();
}

const ok = totals.seamDiffs === 0 && totals.missing === 0 && totals.duplicated === 0 && totals.gaps === 0;
console.log(
  JSON.stringify({
    ...totals,
    avgLiveKB: Math.round(totals.liveBytes / totals.cycles / 1024),
    avgLines: Math.round(totals.lines / totals.cycles),
    result: ok ? "PASS" : "FAIL",
  }),
);
for (const f of failures) console.log(f);
const { leftAlive } = await reap([h]);
console.log(JSON.stringify({ leftAlive }));
fs.rmSync(home, { recursive: true, force: true });
process.exit(ok && leftAlive.length === 0 ? 0 : 1);

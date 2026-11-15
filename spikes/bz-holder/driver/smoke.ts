// S1's smoke run: spawn a holder on sh, type into it, read the echo, drop the connection,
// re-attach from a snapshot, resize it and read the new size back, then close it and check
// nothing is left.
import fs from "node:fs";
import {
  Conn,
  K,
  bytesOf,
  clean,
  diffTerms,
  frame,
  makeHome,
  newTerm,
  offsetOf,
  u64,
  ptyGuard,
  reap,
  sleep,
  spawnHolder,
  write,
} from "./lib.ts";

ptyGuard(1);
const home = makeHome("smoke");
const h = await spawnHolder(home, "smoke", ["/bin/sh"], { cols: 80, rows: 24 });
console.log("spawned", h);

const a = await Conn.connect(h.socket);
let seen = "";
a.onFrame = (f) => {
  if (f.kind === K.R_DATA) seen += bytesOf(f).toString("utf8");
};
a.send(frame(K.SUBSCRIBE, u64(0)));
a.send(frame(K.INPUT, "echo hello-$((40+2))\n"));
for (let i = 0; i < 50 && !seen.includes("hello-42"); i++) await sleep(20);
console.log("echo seen:", seen.includes("hello-42"));
a.close();

const b = await Conn.connect(h.socket);
const snap = b.next(K.R_SNAPSHOT);
b.send(frame(K.SNAPSHOT), frame(K.SUBSCRIBE));
const s = await snap;
const replay = newTerm(80, 24);
await write(replay, bytesOf(s));
console.log("snapshot offset", offsetOf(s), "line0:", JSON.stringify(replay.buffer.active.getLine(1)?.translateToString(true)));
const reference = newTerm(80, 24);
await write(reference, seen);
const d = diffTerms(reference, replay);
console.log("snapshot vs stream:", clean(d) ? "identical" : d);
let resized = "";
b.onFrame = (f) => {
  if (f.kind === K.R_DATA) resized += bytesOf(f).toString("utf8");
};
b.send(frame(K.RESIZE, JSON.stringify({ cols: 100, rows: 30 })), frame(K.INPUT, "stty size\n"));
for (let i = 0; i < 50 && !resized.includes("30 100"); i++) await sleep(20);
console.log("resize seen:", resized.includes("30 100"));
const st = await b.stats();
console.log("stats", st);
b.close();

const { leftAlive } = await reap([h]);
console.log("left alive after close:", leftAlive);
fs.rmSync(home, { recursive: true, force: true });

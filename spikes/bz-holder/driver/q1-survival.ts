// Q1, survival: 25 holders flood (5 seq, 5 yes, 5 cat over 50 MB, 10 busy-agent replays) while
// the stand-in daemon that spawned them is kill -9'd and restarted 50 times. Pass: every holder
// alive, every child still running, no child ever received SIGHUP, and each holder still serves.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Conn, PROGRAMS, type HolderRef, alive, makeHome, ptyGuard, reap, sleep } from "./lib.ts";

const ROUNDS = Number(process.argv[2] ?? 50);
ptyGuard(25);
const home = makeHome("q1");
const gen = spawn("node", [path.join(PROGRAMS, "gen.ts"), "big", path.join(home, "big.txt"), "50"], {
  stdio: "inherit",
});
await new Promise((r) => gen.once("exit", r));

function startDaemon(first: boolean): Promise<{ pid: number; attachMs: number }> {
  const args = [path.join(import.meta.dirname, "daemon.ts"), ...(first ? ["--spawn"] : []), home];
  const started = Date.now();
  const child = spawn("node", args, { stdio: ["ignore", "pipe", "inherit"] });
  return new Promise((resolve, reject) => {
    let out = "";
    child.stdout.on("data", (b: Buffer) => {
      out += b.toString();
      if (out.includes("attached 25")) resolve({ pid: child.pid!, attachMs: Date.now() - started });
    });
    child.once("exit", (code) => reject(new Error(`daemon exited ${code} before attaching: ${out}`)));
  });
}

const attachTimes: number[] = [];
for (let round = 0; round < ROUNDS; round++) {
  const { pid, attachMs } = await startDaemon(round === 0);
  attachTimes.push(attachMs);
  await sleep(1000 + Math.floor(Math.random() * 2000));
  process.kill(pid, "SIGKILL");
  while (alive(pid)) await sleep(10);
}

const refs = JSON.parse(fs.readFileSync(path.join(home, "holders.json"), "utf8")) as HolderRef[];
const holderDeaths = refs.filter((h) => !alive(h.pid)).map((h) => h.id);
const childDeaths = refs.filter((h) => !alive(h.childPid)).map((h) => h.id);
const hups = refs.filter((h) => fs.existsSync(path.join(home, "hup", `${h.id}.log`))).map((h) => h.id);
const notServing: string[] = [];
const exited: string[] = [];
for (const h of refs) {
  try {
    const c = await Conn.connect(h.socket);
    const hello = await c.hello();
    if (hello.exit !== null) exited.push(h.id);
    c.close();
  } catch {
    notServing.push(h.id);
  }
}
const ok = [holderDeaths, childDeaths, hups, notServing, exited].every((l) => l.length === 0);
console.log(
  JSON.stringify({
    holders: refs.length,
    daemonKills: ROUNDS,
    holderDeaths,
    childDeaths,
    childrenHup: hups,
    notServing,
    exited,
    attachMsMax: Math.max(...attachTimes.slice(1)),
    result: ok ? "PASS" : "FAIL",
  }),
);
const { leftAlive } = await reap(refs);
console.log(JSON.stringify({ leftAlive }));
fs.rmSync(home, { recursive: true, force: true });
process.exit(ok && leftAlive.length === 0 ? 0 : 1);

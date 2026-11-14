// Fd limits: run under `ulimit -n 256` (see notes). Spawns 100 holders, subscribes to all
// of them, and checks each streams. Also lists one child's fd table: a child must hold only its
// stdio, never the holder's socket or PTY master.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { Conn, K, type HolderRef, frame, makeHome, ptyGuard, reap, sleep, spawnHolder } from "./lib.ts";

const N = 100;
const limit = (pid: number | "self") =>
  process.platform === "linux"
    ? /Max open files\s+(\d+)\s+(\d+)/.exec(fs.readFileSync(`/proc/${pid}/limits`, "utf8"))?.slice(1, 3)
    : execFileSync("sh", ["-c", "ulimit -n"], { encoding: "utf8" }).trim();
ptyGuard(N + 1);
const home = makeHome("fds");
const holders: HolderRef[] = [];
let spawnFailures = 0;
for (let i = 0; i < N; i++) {
  try {
    holders.push(await spawnHolder(home, `h${i}`, ["/bin/sh", "-c", "while :; do echo tick; sleep 0.2; done"]));
  } catch (e) {
    spawnFailures++;
    if (spawnFailures === 1) console.log(String(e).slice(0, 300));
  }
}
const streaming = new Set<string>();
const conns: Conn[] = [];
let connectFailures = 0;
for (const h of holders) {
  try {
    const c = await Conn.connect(h.socket);
    c.onFrame = (f) => void (f.kind === K.R_DATA && streaming.add(h.id));
    c.send(frame(K.SNAPSHOT), frame(K.SUBSCRIBE));
    conns.push(c);
  } catch {
    connectFailures++;
  }
}
await sleep(3000);

const plain = await spawnHolder(home, "plain", ["sleep", "600"]);
holders.push(plain);
const childFds =
  process.platform === "linux"
    ? fs.readdirSync(`/proc/${plain.childPid}/fd`).map((fd) => `${fd}->${fs.readlinkSync(`/proc/${plain.childPid}/fd/${fd}`)}`)
    : execFileSync("lsof", ["-p", String(plain.childPid)], { encoding: "utf8" }).split("\n").slice(1).filter(Boolean);
const ok = spawnFailures === 0 && connectFailures === 0 && streaming.size === N;
console.log(
  JSON.stringify({
    driverNofile: limit("self"),
    holderNofile: holders[0] ? limit(holders[0].pid) : null,
    spawned: holders.length - 1,
    spawnFailures,
    connectFailures,
    streaming: streaming.size,
    result: ok ? "PASS" : "FAIL",
    childFds,
  }),
);
for (const c of conns) c.close();
const { leftAlive } = await reap(holders);
console.log(JSON.stringify({ leftAlive }));
fs.rmSync(home, { recursive: true, force: true });
process.exit(ok && leftAlive.length === 0 ? 0 : 1);

// A stand-in daemon for the survival run: with --spawn <home> it first spawns the 25 load holders and writes
// their refs to <home>/holders.json. Either way it then attaches to every holder (snapshot +
// subscribe), drains their streams, prints "attached N", and runs until it is killed.
import fs from "node:fs";
import path from "node:path";
import { Conn, K, PROGRAMS, REPLAY, type HolderRef, frame, hupTrapped, spawnHolder } from "./lib.ts";

const spawnFirst = process.argv[2] === "--spawn";
const home = process.argv[spawnFirst ? 3 : 2]!;
const refsFile = path.join(home, "holders.json");

if (spawnFirst) {
  const big = path.join(home, "big.txt");
  const agent = path.join(PROGRAMS, "recordings", "agent-synthetic.bin");
  const loads: [string, string][] = [
    ...Array.from({ length: 5 }, (_, i) => [`seq${i}`, "while :; do seq 1 200000; done"] as [string, string]),
    ...Array.from({ length: 5 }, (_, i) => [`yes${i}`, "yes"] as [string, string]),
    ...Array.from({ length: 5 }, (_, i) => [`cat${i}`, `while :; do cat '${big}'; done`] as [string, string]),
    ...Array.from({ length: 10 }, (_, i) => [`agent${i}`, `'${REPLAY}' '${agent}' 50`] as [string, string]),
  ];
  fs.mkdirSync(path.join(home, "hup"), { recursive: true });
  const refs: HolderRef[] = [];
  for (const [id, load] of loads) {
    refs.push(await spawnHolder(home, id, hupTrapped(load, path.join(home, "hup", `${id}.log`))));
  }
  fs.writeFileSync(refsFile, JSON.stringify(refs));
}

const refs = JSON.parse(fs.readFileSync(refsFile, "utf8")) as HolderRef[];
const conns: Conn[] = [];
for (const h of refs) {
  const c = await Conn.connect(h.socket);
  const snap = c.next(K.R_SNAPSHOT);
  c.send(frame(K.SNAPSHOT), frame(K.SUBSCRIBE));
  await snap;
  conns.push(c);
}
process.stdout.write(`attached ${conns.length}\n`);
setInterval(() => {}, 1 << 30);

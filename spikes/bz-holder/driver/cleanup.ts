import fs from "node:fs"; import path from "node:path";
import { Conn, reap, type HolderRef } from "./lib.ts";
const refs: HolderRef[] = [];
for (const home of process.argv.slice(2)) { const dir = path.join(home, "run", "holders");
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sock"))) { const socket = path.join(dir, f);
    try { const c = await Conn.connect(socket); const h = await c.hello(); c.close(); refs.push({ id: f, pid: h.holderPid, childPid: h.childPid, socket }); } catch {} } }
console.log("found", refs.length, JSON.stringify(await reap(refs)));

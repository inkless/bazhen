import fs from "node:fs"; import path from "node:path";
import { hupTrapped, makeHome, reap, sleep, spawnHolder } from "./lib.ts";
const home = makeHome("hupctl"); const log = path.join(home, "hup.log");
const h = await spawnHolder(home, "y", hupTrapped("yes", log));
await sleep(300); const before = fs.existsSync(log);
process.kill(-h.childPid, "SIGHUP"); await sleep(300);
console.log(JSON.stringify({ before, after: fs.existsSync(log) && fs.readFileSync(log, "utf8").trim() }));
console.log(JSON.stringify(await reap([h]))); fs.rmSync(home, { recursive: true, force: true });

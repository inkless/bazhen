// Q7, macOS lifetime. See RUNBOOK-macos.md.
//   node driver/q7.ts start          from inside the terminal app under test: launches a stand-in
//                                    daemon detached (setsid, stdio to files), which spawns three
//                                    holders; prints the home to pass to `check`.
//   node driver/q7.ts check <home>   from any terminal, after quitting/closing/force-quitting:
//                                    daemon, holders and children alive, no SIGHUP, TCC access.
//   node driver/q7.ts stop <home>    closes everything it started.
//   (serve <home> is internal: the detached daemon.)
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Conn, K, type HolderRef, alive, frame, hupTrapped, makeHome, reap, sleep, spawnHolder } from "./lib.ts";

const [mode, homeArg] = process.argv.slice(2);

if (mode === "start") {
  const home = makeHome("q7");
  const out = fs.openSync(path.join(home, "daemon.out"), "a");
  // macOS has no setsid(1); perl's POSIX::setsid is in the base system.
  const child = spawn(
    "perl",
    ["-MPOSIX", "-e", "POSIX::setsid(); exec @ARGV", process.execPath, import.meta.filename, "serve", home],
    { detached: true, stdio: ["ignore", out, out] },
  );
  child.unref();
  for (let i = 0; i < 100 && !fs.existsSync(path.join(home, "holders.json")); i++) await sleep(100);
  console.log(fs.existsSync(path.join(home, "holders.json")) ? `started: ${home}` : `failed; see ${home}/daemon.out`);
  process.exit(0);
}

const home = homeArg!;
const refsFile = path.join(home, "holders.json");

if (mode === "serve") {
  fs.mkdirSync(path.join(home, "hup"), { recursive: true });
  const refs: HolderRef[] = [];
  const loads = {
    ticker: "while :; do date; sleep 1; done",
    seq: "while :; do seq 1 20000; sleep 1; done",
  };
  for (const [id, load] of Object.entries(loads)) {
    refs.push(await spawnHolder(home, id, hupTrapped(load, path.join(home, "hup", `${id}.log`))));
  }
  // A shell reads its terminal, so it can't sit behind the trap wrapper's background job.
  refs.push(await spawnHolder(home, "shell", ["/bin/sh"]));
  fs.writeFileSync(path.join(home, "daemon.pid"), String(process.pid));
  fs.writeFileSync(refsFile, JSON.stringify(refs));
  for (const h of refs) {
    const c = await Conn.connect(h.socket);
    c.send(frame(K.SNAPSHOT), frame(K.SUBSCRIBE));
  }
  setInterval(() => {}, 1 << 30);
}

if (mode === "check") {
  const refs = JSON.parse(fs.readFileSync(refsFile, "utf8")) as HolderRef[];
  const daemonPid = Number(fs.readFileSync(path.join(home, "daemon.pid"), "utf8"));
  const shell = refs.find((h) => h.id === "shell")!;
  const tcc = path.join(home, "tcc.txt");
  fs.rmSync(tcc, { force: true });
  const c = await Conn.connect(shell.socket);
  c.send(frame(K.INPUT, `ls ~/Desktop ~/Documents > '${tcc}' 2>&1; echo "exit=$?" >> '${tcc}'\n`));
  for (let i = 0; i < 50 && !fs.existsSync(tcc); i++) await sleep(100);
  await sleep(300);
  c.close();
  const tccText = fs.existsSync(tcc) ? fs.readFileSync(tcc, "utf8") : "";
  const result = {
    daemonAlive: alive(daemonPid),
    holdersAlive: refs.filter((h) => alive(h.pid)).map((h) => h.id),
    childrenAlive: refs.filter((h) => alive(h.childPid)).map((h) => h.id),
    hups: refs.filter((h) => fs.existsSync(path.join(home, "hup", `${h.id}.log`))).map((h) => h.id),
    tccExit: /exit=(\d+)/.exec(tccText)?.[1] ?? "no answer",
    tccDenied: /Operation not permitted/.test(tccText),
  };
  const ok =
    result.holdersAlive.length === refs.length &&
    result.childrenAlive.length === refs.length &&
    result.hups.length === 0 &&
    result.tccExit === "0";
  console.log(JSON.stringify({ ...result, result: ok ? "PASS" : "FAIL" }));
}

if (mode === "stop") {
  const refs = JSON.parse(fs.readFileSync(refsFile, "utf8")) as HolderRef[];
  const daemonPid = Number(fs.readFileSync(path.join(home, "daemon.pid"), "utf8"));
  if (alive(daemonPid)) process.kill(daemonPid, "SIGKILL");
  console.log(JSON.stringify(await reap(refs)));
  fs.rmSync(home, { recursive: true, force: true });
}

// Records a program for the parity check: `node driver/record.ts [--keylog <file>] <command> [args...]`.
// Runs it in a 120x40 holder mirrored in this terminal (make the window at least that big). Ctrl-],
// the program exiting, or `kill <pid>` from any shell saves programs/recordings/<command>.bin and
// closes the holder; a lost holder or a crash saves <command>.partial.bin instead. --keylog appends
// each stdin chunk to <file> as ms since start, hex and JSON, and each keyboard-protocol sequence
// the program writes, to see what a key really sends.
import fs from "node:fs";
import path from "node:path";
import { Conn, PROGRAMS, makeHome, reap, spawnHolder } from "./lib.ts";
import { saveAtomic, startRecorder } from "./recorder.ts";

if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error("record.ts mirrors a program into this terminal: run it with stdin and stdout on a terminal");
  process.exit(2);
}

const argv = process.argv.slice(2);
const keylogFd = argv[0] === "--keylog" ? fs.openSync(argv.splice(0, 2)[1]!, "a") : null;
const started = Date.now();
const name = path.basename(argv[0]!);
const home = makeHome("rec");
const h = await spawnHolder(home, name, argv, { cols: 120, rows: 40 });
const conn = await Conn.connect(h.socket).catch(async (e: unknown) => {
  await reap([h]);
  fs.rmSync(home, { recursive: true, force: true });
  throw e;
});

startRecorder({
  name,
  home,
  conn,
  stdin: process.stdin,
  proc: process,
  write: (text) => fs.writeSync(1, text),
  mirror: (bytes) => process.stdout.write(bytes),
  recordingPath: (partial) => path.join(PROGRAMS, "recordings", `${name}${partial ? ".partial" : ""}.bin`),
  save: saveAtomic,
  reap: () => reap([h]),
  removeHome: () => fs.rmSync(home, { recursive: true, force: true }),
  keylog: keylogFd === null ? undefined : (line) => fs.writeSync(keylogFd, `${Date.now() - started} ${line}\n`),
});

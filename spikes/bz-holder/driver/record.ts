// Records a program for the parity check: `node driver/record.ts [--keylog <file>] <command> [args...]`.
// Runs it in a 120x40 holder mirrored in this terminal (make the window at least that big); Ctrl-]
// stops, saves programs/recordings/<command>.bin and closes the holder. --keylog appends each stdin
// chunk to <file> as ms since start, hex and JSON, to see what a key really sends, and each
// keyboard-protocol sequence the program writes (kitty `CSI > u` and friends, modifyOtherKeys).
import fs from "node:fs";
import path from "node:path";
import { Conn, K, PROGRAMS, bytesOf, frame, makeHome, reap, spawnHolder, u64 } from "./lib.ts";

const argv = process.argv.slice(2);
const keylog = argv[0] === "--keylog" ? fs.openSync(argv.splice(0, 2)[1]!, "a") : null;
const started = Date.now();
const logLine = (line: string) => keylog !== null && fs.writeSync(keylog, `${Date.now() - started} ${line}\n`);
const keyboardProtocol = /\x1b\[(?:[<=>?][\d;:]*u|>4(?:;\d*)?m)/g;
const name = path.basename(argv[0]!);
const home = makeHome("rec");
const h = await spawnHolder(home, name, argv, { cols: 120, rows: 40 });
const c = await Conn.connect(h.socket);
const chunks: Buffer[] = [];
c.onFrame = (f) => {
  if (f.kind !== K.R_DATA) return;
  chunks.push(bytesOf(f));
  for (const m of bytesOf(f).toString("latin1").matchAll(keyboardProtocol)) logLine(`out ${JSON.stringify(m[0])}`);
  process.stdout.write(bytesOf(f));
};
c.send(frame(K.SUBSCRIBE, u64(0)));
process.stdin.setRawMode(true);
process.stdin.on("data", async (key: Buffer) => {
  logLine(`in ${key.toString("hex")} ${JSON.stringify(key.toString("latin1"))}`);
  if (key.includes(0x1d)) {
    process.stdin.setRawMode(false);
    const out = path.join(PROGRAMS, "recordings", `${name}.bin`);
    fs.writeFileSync(out, Buffer.concat(chunks));
    c.close();
    await reap([h]);
    fs.rmSync(home, { recursive: true, force: true });
    process.stdout.write(`\x1b[0m\x1b[?1049l\r\nsaved ${out}\r\n`);
    process.exit(0);
  }
  c.send(frame(K.INPUT, key));
});

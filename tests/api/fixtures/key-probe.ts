// Records each chunk of input the terminal delivers, with the time it arrived, one line per chunk:
// `<epoch ms> <hex bytes>`. Run in a terminal; the log path is the only argument.
import { appendFileSync } from "node:fs";

const log = process.argv[2];
if (log === undefined) throw new Error("usage: key-probe <log file>");
process.stdin.setRawMode(true);
// Asks for focus reports, as a program that wants them does; tmux forwards none otherwise.
process.stdout.write("\x1b[?1004hkey-probe ready\r\n");
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(log, `${Date.now()} ${chunk.toString("hex")}\n`);
});

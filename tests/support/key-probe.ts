// Records each chunk of input the terminal delivers, with the time it arrived, one line per chunk:
// `<epoch ms> <hex bytes>`. Run in a terminal as `key-probe <log file> [options]`:
//   --lines=N     print N numbered lines first, so the terminal has scrollback
//   --mouse       ask for mouse reports, SGR-encoded, as Claude Code does
//   --alternate-on-key   switch to the alternate screen when a "!" arrives
//   --app-cursor  ask for application cursor keys (DECCKM), as vim and less do
//   --echo-after=MS   write each chunk back MS ms after it arrives, as a TUI that draws late does
import { appendFileSync } from "node:fs";

const [log, ...options] = process.argv.slice(2);
if (log === undefined) throw new Error("usage: key-probe <log file> [options]");
const numeric = (name: string) => {
  const value = options.find((o) => o.startsWith(`${name}=`))?.slice(name.length + 1);
  return value === undefined ? undefined : Number(value);
};
const lines = numeric("--lines") ?? 0;
const echoAfter = numeric("--echo-after");
process.stdin.setRawMode(true);
for (let i = 1; i <= lines; i++) process.stdout.write(`line ${i}\r\n`);
if (options.includes("--mouse")) process.stdout.write("\x1b[?1000h\x1b[?1006h");
if (options.includes("--app-cursor")) process.stdout.write("\x1b[?1h");
// Focus reports too, as a program that wants them asks; tmux forwards none otherwise.
process.stdout.write("\x1b[?1004hkey-probe ready\r\n");
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(log, `${Date.now()} ${chunk.toString("hex")}\n`);
  if (echoAfter !== undefined) setTimeout(() => process.stdout.write(chunk), echoAfter);
  if (options.includes("--alternate-on-key") && chunk.includes("!")) {
    process.stdout.write("\x1b[?1049hon the alternate screen\r\n");
  }
});

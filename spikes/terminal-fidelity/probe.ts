// Runs inside a tmux pane in place of a TUI. Raw tty; logs every input chunk as hex (to the screen
// and as JSON lines to a file), after asking for whichever terminal modes the flags name.
import { appendFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const log = args.find((a) => !a.startsWith("--")) ?? "/dev/null";
const has = (f: string) => args.some((a) => a === f || a.startsWith(`${f}=`));
const val = (f: string) => args.find((a) => a.startsWith(`${f}=`))?.split("=")[1];

const modes: string[] = [];
if (has("--mouse")) modes.push("\x1b[?1000h\x1b[?1002h\x1b[?1006h");
if (has("--paste")) modes.push("\x1b[?2004h");
if (has("--focus")) modes.push("\x1b[?1004h");
if (has("--mok")) modes.push(`\x1b[>4;${val("--mok") ?? 2}m`);
if (has("--kitty")) modes.push(`\x1b[>${val("--kitty") ?? 1}u`);
if (has("--alt")) modes.push("\x1b[?1049h");

writeFileSync(log, "");
process.stdin.setRawMode(true);
process.stdout.write(modes.join(""));
if (has("--query")) process.stdout.write("\x1b[?u\x1b[c"); // kitty flags query + DA1 as a fence
process.stdout.write(`probe ready ${args.join(" ")}\r\n`);

const vis = (b: Buffer) =>
  [...b].map((c) => (c === 0x1b ? "ESC" : c < 0x20 ? `^${String.fromCharCode(c + 64)}` : c === 0x7f ? "DEL" : String.fromCharCode(c))).join("");

process.stdin.on("data", (b: Buffer) => {
  appendFileSync(log, JSON.stringify({ t: performance.now(), hex: b.toString("hex"), vis: vis(b) }) + "\n");
  process.stdout.write(`IN ${b.toString("hex")} ${JSON.stringify(vis(b))}\r\n`);
  if (b.toString() === "\x1b[24~QUIT") process.exit(0);
});

// Generates the spike's synthetic loads, deterministically.
//   node gen.ts agent <out>         an agent-like stream: SGR, spinner redraws, diffs, boxes
//   node gen.ts sgr160 <out> <n>    n lines of 160-column, SGR-heavy text, for the memory runs
//   node gen.ts big <out> <mb>      a plain-text file of about mb MB, for the cat loop
import fs from "node:fs";

let seed = 42;
const rand = (n: number) => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed % n;
};
const words = "the holder keeps a ring of bytes by offset and answers queries itself while the daemon restarts".split(" ");
const sentence = (n: number) => Array.from({ length: n }, () => words[rand(words.length)]).join(" ");
const spinner = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

function agent(): string {
  const out: string[] = [];
  for (let turn = 0; turn < 120; turn++) {
    out.push(`\x1b[38;5;${rand(230) + 16}m●\x1b[0m \x1b[1m${["Read", "Edit", "Bash", "Grep"][rand(4)]}\x1b[0m(src/${sentence(1)}.ts)\r\n`);
    for (let s = 0; s < 6; s++) {
      out.push(`\r\x1b[2K\x1b[33m${spinner[s % spinner.length]}\x1b[0m \x1b[2mThinking… (${s}s · esc to interrupt)\x1b[0m`);
    }
    out.push("\r\x1b[2K");
    out.push(`  ⎿  ${sentence(8 + rand(10))}\r\n`);
    if (turn % 3 === 0) {
      for (let d = 0; d < 4; d++) {
        const add = rand(2) === 0;
        const bg = add ? "48;2;20;60;20" : "48;2;70;20;20";
        out.push(`     \x1b[${bg}m${add ? "+" : "-"} ${sentence(6)}\x1b[0m\r\n`);
      }
    }
    if (turn % 10 === 0) {
      out.push(`╭${"─".repeat(60)}╮\r\n│ \x1b[1;36m${sentence(5).padEnd(58).slice(0, 58)}\x1b[0m │\r\n╰${"─".repeat(60)}╯\r\n`);
      // A status block redrawn in place, as TUIs repaint their footer.
      out.push(`\x1b[2A\x1b[2K│ ${"updated".padEnd(58)} │\x1b[2B\r`);
      out.push("\n");
    }
  }
  return out.join("");
}

function sgr160(lines: number): string {
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    let line = "";
    let width = 0;
    while (width < 160) {
      const word = words[rand(words.length)]!.slice(0, 160 - width);
      line += `\x1b[${rand(2) ? 1 : 22};38;5;${rand(256)};48;5;${rand(256)}m${word}`;
      width += word.length;
    }
    out.push(`${line}\x1b[0m\r\n`);
  }
  return out.join("");
}

function big(mb: number): string {
  const lines: string[] = [];
  let size = 0;
  while (size < mb * 1024 * 1024) {
    const l = `${String(lines.length).padStart(8, "0")} ${sentence(14)}\n`;
    lines.push(l);
    size += l.length;
  }
  return lines.join("");
}

const [what, out, n] = process.argv.slice(2);
if (!what || !out) throw new Error("usage: gen.ts agent|sgr160|big <out> [n]");
const content = what === "agent" ? agent() : what === "sgr160" ? sgr160(Number(n)) : big(Number(n));
fs.writeFileSync(out, content);

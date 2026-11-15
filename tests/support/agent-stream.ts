// Generated terminal streams, the same on every run: what an agent's session prints, and the
// worst case for the engine's history store. The engine's bench replays them, and the holder's
// contract tests run them through a real holder.

/** How wide `sgrStream`'s lines are. */
const SGR_COLS = 160;

/** A deterministic stream of pseudo-random numbers below `n`, the same on every run. */
function randomBelow(): (n: number) => number {
  let seed = 42;
  return (n) => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7f_ff_ff_ff;
    return seed % n;
  };
}

const WORDS =
  "the holder keeps a ring of bytes by offset and answers queries itself while the daemon restarts".split(
    " ",
  );
const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";

/**
 * An agent-like stream of at least `lines` lines: tool calls in colour, spinner redraws, diffs on
 * coloured backgrounds, boxes, and a footer repainted in place.
 */
export function agentStream(lines: number): string {
  const rand = randomBelow();
  const sentence = (n: number) =>
    Array.from({ length: n }, () => WORDS[rand(WORDS.length)]).join(" ");
  const out: string[] = [];
  let written = 0;
  for (let turn = 0; written < lines; turn++) {
    const tool = ["Read", "Edit", "Bash", "Grep"][rand(4)];
    out.push(
      `\x1b[38;5;${rand(230) + 16}m●\x1b[0m \x1b[1m${tool}\x1b[0m(src/${sentence(1)}.ts)\r\n`,
    );
    for (let s = 0; s < 6; s++) {
      const frame = SPINNER[s % SPINNER.length];
      out.push(
        `\r\x1b[2K\x1b[33m${frame}\x1b[0m \x1b[2mThinking… (${s}s · esc to interrupt)\x1b[0m`,
      );
    }
    out.push(`\r\x1b[2K  ⎿  ${sentence(8 + rand(10))}\r\n`);
    written += 2;
    if (turn % 3 === 0) {
      for (let d = 0; d < 4; d++) {
        const add = rand(2) === 0;
        const bg = add ? "48;2;20;60;20" : "48;2;70;20;20";
        out.push(`     \x1b[${bg}m${add ? "+" : "-"} ${sentence(6)}\x1b[0m\r\n`);
      }
      written += 4;
    }
    if (turn % 10 === 0) {
      const title = sentence(5).padEnd(58).slice(0, 58);
      out.push(`╭${"─".repeat(60)}╮\r\n│ \x1b[1;36m${title}\x1b[0m │\r\n╰${"─".repeat(60)}╯\r\n`);
      out.push(`\x1b[2A\x1b[2K│ ${"updated".padEnd(58)} │\x1b[2B\r\n`);
      written += 4;
    }
  }
  return out.join("");
}

/** `lines` lines 160 columns wide, every word in its own bold, foreground and background. */
export function sgrStream(lines: number): string {
  const rand = randomBelow();
  const out: string[] = [];
  for (let i = 0; i < lines; i++) {
    let line = "";
    let width = 0;
    while (width < SGR_COLS) {
      const word = (WORDS[rand(WORDS.length)] ?? "").slice(0, SGR_COLS - width);
      line += `\x1b[${rand(2) ? 1 : 22};38;5;${rand(256)};48;5;${rand(256)}m${word}`;
      width += word.length;
    }
    out.push(`${line}\x1b[0m\r\n`);
  }
  return out.join("");
}
